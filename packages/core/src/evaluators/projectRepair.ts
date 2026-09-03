// ============================================================
// Project Repair 评分器 v1.2（多文件工作区 + 容器执行测试套件）
// 场景 requirements：
//   files: [{path, content}]             —— 模型可见的初始工作区
//   hiddenTestFiles?: [{path, content}]  —— grader 注入的隐藏测试文件（模型不可见）
//   hiddenTests?: [{description, script}] —— 隐藏测试执行命令
//   publicTests?: [{description, script}] —— 公开测试执行命令
//   functionName?: string                —— 入口函数（api_stability 用）
//   explanationKeywords?: string[]       —— 静态信号关键词
//   image?: string                       —— 覆盖默认容器镜像
//   executionPolicy?:                    —— 显式执行策略；默认禁网
//     network: 'required'                —— 仅题目声明时允许联网
//     dependencyPreflight                —— 用原始工作区检查依赖仓库
//     coldStartTimeoutIsEnvironmentError —— 联网冷启动超时隔离，不归罪模型
// 模型输出：多文件「完整内容」，每个文件一个代码块，前一行用标题行
//   标注路径。兼容多种自然写法（parseFileBlocks 解析）：
//     `### file: <path>`          规范格式
//     `### \`<path>\``             反引号包路径
//     `### 1. \`<path>\` —— 说明` 编号 + 描述
//     `#### \`<path>\``           任意标题层级
//   未标注路径或不像文件路径的标题（如 `### 实现思路`）忽略。
// 评分轴：test_pass(25) + api_stability(15) + static_signals(30)
//          + output_completeness(15) + scope_discipline(15)，权重可被
//          scenario.scoring.weights 覆盖。
// ============================================================

import type { Scenario, ScenarioResult, ModelResponse, OutputMetadata, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { runInContainer, isDockerAvailable, stripMavenEntrypointNoise } from '../execution/index.js';
import { detectEnvironmentError } from './harnessErrors.js';

/** 语言 → 默认容器镜像 */
const LANG_IMAGE: Record<string, string> = {
  python: 'python:3.12-alpine',
  javascript: 'node:20-alpine',
  typescript: 'node:20-alpine',
  go: 'golang:1.22-alpine',
  java: 'maven:3.9-eclipse-temurin-17-alpine',  // 原 jdk 镜像无 mvn，mvn test exit=127
  rust: 'rust:1-alpine',
  c: 'gcc:13',
  cpp: 'gcc:13',
  csharp: 'mcr.microsoft.com/dotnet/sdk:8.0',
  php: 'php:8.2-cli-alpine',
  bash: 'bash:5',
  shell: 'bash:5',
  sql: 'postgres:15',
};

interface ProjectRepairRequirements {
  files?: { path: string; content: string }[];
  hiddenTestFiles?: { path: string; content: string }[];
  hiddenTests?: { description: string; script: string }[];
  publicTests?: { description: string; script: string }[];
  functionName?: string;
  explanationKeywords?: string[];
  image?: string;
  executionPolicy?: {
    network?: 'required' | 'disabled';
    dependencyPreflight?: { command: string; timeoutMs?: number };
    coldStartTimeoutIsEnvironmentError?: boolean;
  };
}

/** 纯解析函数从独立模块导入（零运行时依赖，便于单测与隔离 dockerode）。 */
import { normalizePath, parseFileBlocks } from './patchParser.js';

/** 物化工作区：初始文件 + 模型替换 + 隐藏测试文件 → ContainerFile[]。
 *  替换按规范化路径匹配 initial 文件 key，避免模型写法（./ 前缀、反斜杠）
 *  与 initial 不一致时变成「新建一份」而非替换，导致旧错误代码仍被测试。 */
function buildWorkspaceFiles(
  initial: { path: string; content: string }[],
  replacements: Record<string, string>,
  hidden: { path: string; content: string }[],
) {
  const map = new Map<string, string>();
  const normIdx = new Map<string, string>(); // 规范化路径 -> map key
  for (const f of initial) {
    map.set(f.path, f.content);
    normIdx.set(normalizePath(f.path), f.path);
  }
  for (const [rPath, content] of Object.entries(replacements)) {
    const n = normalizePath(rPath);
    const existing = normIdx.get(n);
    if (existing) {
      map.set(existing, content);  // 命中已有文件 → 替换，保持原始路径 key
    } else {
      map.set(rPath, content);    // 新文件
      normIdx.set(n, rPath);
    }
  }
  for (const f of hidden) {
    const n = normalizePath(f.path);
    const existing = normIdx.get(n);
    if (existing) map.set(existing, f.content);
    else { map.set(f.path, f.content); normIdx.set(n, f.path); }
  }
  return [...map.entries()].map(([path, content]) => ({ path, content }));
}

/** 单脚本执行结果 */
interface ScriptRunResult {
  passed: boolean;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const EVIDENCE_STREAM_LIMIT = 2_000;

/** 以结构化形式保留两个输出流，既保留根因又避免数据库证据无限膨胀。 */
function appendExecutionEvidence(
  evidence: string[],
  kind: 'preflight' | 'hidden_test',
  description: string,
  result: ScriptRunResult,
) {
  const clip = (value: string) => ({
    value: value.slice(0, EVIDENCE_STREAM_LIMIT),
    truncated: value.length > EVIDENCE_STREAM_LIMIT,
  });
  const stdout = clip(result.stdout);
  const stderr = clip(result.stderr);
  evidence.push(`EXECUTION_EVIDENCE: ${JSON.stringify({
    kind,
    description,
    passed: result.passed,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: stdout.value,
    stderr: stderr.value,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  })}`);
}

/** 在容器中跑单个测试脚本（脚本是 shell 命令，如 'pytest -q tests/hidden/x.py'） */
async function runScript(
  image: string,
  files: { path: string; content: string }[],
  script: string,
  timeoutMs: number,
  opts?: { pg?: boolean; networkDisabled?: boolean },
): Promise<ScriptRunResult> {
  let command = script;
  let user: string | undefined;
  let memoryMb = 512;
  if (opts?.pg) {
    const pgSetup = [
      'export PGDATA=/tmp/pgdata',
      'initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null 2>&1',
      "pg_ctl -D \"$PGDATA\" -w -o '-p 5432 -c listen_addresses=127.0.0.1' start >/dev/null 2>&1",
    ].join(' && ');
    command = pgSetup + ' && ' + script;
    user = 'postgres';
    memoryMb = 1024;
  }
  const res = await runInContainer({
    image,
    command: ['sh', '-c', command],
    files,
    timeoutMs,
    memoryMb,
    pidsLimit: 256,
    // 默认禁网；只有题目 executionPolicy 明确声明依赖网络时才开放。
    networkDisabled: opts?.networkDisabled ?? true,
    readOnly: false,  // 长任务需要写文件（DB/缓存/产物）
    user,
    // HOME：非 root(65534) 下默认 /nonexistent，dotnet/go 需要可写 HOME
    // MAVEN_CONFIG：把 maven entrypoint 的 .m2 从 /root/.m2 改到 /tmp/.m2，
    // 从源头消除 `mkdir: cannot create directory '/root'` 这条良性警告
    env: { HOME: '/tmp', MAVEN_CONFIG: '/tmp/.m2' },
  });
  return {
    passed: res.exitCode === 0 && !res.timedOut,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

export const projectRepairEvaluator: Evaluator = {
  name: 'project_repair',
  version: '1.2.0',

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    metadata: OutputMetadata,
    _modelResponse?: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};
    const evidence: string[] = [];
    const lang = (scenario.language || 'python').toLowerCase();
    const req = (scenario.requirements ?? {}) as unknown as ProjectRepairRequirements;

    const initialFiles = req.files ?? [];
    const hiddenFiles = req.hiddenTestFiles ?? [];
    const hiddenTests = req.hiddenTests ?? [];
    const image = req.image ?? LANG_IMAGE[lang] ?? 'python:3.12-alpine';
    const executionPolicy = req.executionPolicy;
    const requiresNetwork = executionPolicy?.network === 'required';
    const isSql = lang === 'sql' || lang === 'postgresql';

    // 1. 解析模型输出的多文件替换
    if (process.env.ZXB_PR_TRACE) console.log('[PR] 1 parseFileBlocks 开始');
    const replacements = parseFileBlocks(modelOutput);
    if (process.env.ZXB_PR_TRACE) console.log('[PR] 1 完成 replacements=' + Object.keys(replacements).length);
    axisScores.output_completeness = Object.keys(replacements).length > 0 ? 100 : 0;
    axisEvidence.output_completeness = 'rule';
    evidence.push('解析到 ' + Object.keys(replacements).length + ' 个文件替换');

    // 2. 物化工作区
    if (process.env.ZXB_PR_TRACE) console.log('[PR] 2 buildWorkspaceFiles 开始');
    const workspaceFiles = buildWorkspaceFiles(initialFiles, replacements, hiddenFiles);
    if (process.env.ZXB_PR_TRACE) console.log('[PR] 2 完成 files=' + workspaceFiles.length);

    // 3. 跑隐藏测试脚本
    if (process.env.ZXB_PR_TRACE) console.log('[PR] 3 isDockerAvailable 开始');
    const dockerOk = await isDockerAvailable();
    if (process.env.ZXB_PR_TRACE) console.log('[PR] 3 isDockerAvailable=' + dockerOk);
    if (!dockerOk) {
      evidence.push('ENVIRONMENT_ERROR: docker daemon unreachable — harness 故障，非模型错误，已隔离（unmeasured）');
      return {
        axisScores: { test_pass: 0, output_completeness: axisScores.output_completeness ?? 0 },
        axisEvidence: { test_pass: 'unmeasured', output_completeness: 'rule' },
        totalScore: 0,
        safetyLevel: 'safe',
        evidence,
        environmentError: true,
      } as Partial<ScenarioResult>;
    }

    // 联网题的依赖预检必须在模型改动前的原始工作区中执行。否则模型把
    // Cargo.toml / package.json / csproj 改坏后，会被错误归因为环境网络故障。
    if (requiresNetwork) {
      const preflight = executionPolicy?.dependencyPreflight;
      if (!preflight?.command?.trim()) {
        evidence.push('ENVIRONMENT_ERROR: network-required scenario has no dependency preflight policy');
        return {
          axisScores: { test_pass: 0, output_completeness: axisScores.output_completeness ?? 0 },
          axisEvidence: { test_pass: 'unmeasured', output_completeness: 'rule' },
          totalScore: 0,
          safetyLevel: 'safe',
          evidence,
          environmentError: true,
        } as Partial<ScenarioResult>;
      }
      const baselineFiles = buildWorkspaceFiles(initialFiles, {}, hiddenFiles);
      const preflightResult = await runScript(
        image,
        baselineFiles,
        preflight.command,
        preflight.timeoutMs ?? 120_000,
        { pg: isSql, networkDisabled: false },
      );
      appendExecutionEvidence(evidence, 'preflight', 'dependency preflight', preflightResult);
      if (!preflightResult.passed) {
        evidence.push('ENVIRONMENT_ERROR: dependency preflight failed on the original workspace — harness/network unavailable');
        return {
          axisScores: { test_pass: 0, output_completeness: axisScores.output_completeness ?? 0 },
          axisEvidence: { test_pass: 'unmeasured', output_completeness: 'rule' },
          totalScore: 0,
          safetyLevel: 'safe',
          evidence,
          environmentError: true,
        } as Partial<ScenarioResult>;
      }
    }

    const results: ScriptRunResult[] = [];
    let envErrorReason: string | null = null;
    for (const ht of hiddenTests) {
      if (!ht.script || !ht.script.trim()) {
        evidence.push('跳过无 script 的测试: ' + ht.description);
        continue;
      }
      if (process.env.ZXB_PR_TRACE) console.log('[PR] 4 runScript 开始 image=' + image + ' timeout=' + (isSql ? 180000 : 120000));
      const r = await runScript(image, workspaceFiles, ht.script, isSql ? 180000 : 120000, { pg: isSql, networkDisabled: !requiresNetwork });
      if (process.env.ZXB_PR_TRACE) console.log('[PR] 4 runScript 完成 passed=' + r.passed + ' exit=' + r.exitCode);
      results.push(r);
      // 先剥离 maven entrypoint 的良性噪音再判环境故障：否则 Java 工程题明明跑了
      // 测试（有 PASS/FAIL），却被 `mkdir /root: Permission denied` 命中
      // `HOME=/root unwritable` 模式，把已判的 test_pass 整块隔离掉。
      const stderr = stripMavenEntrypointNoise(r.stderr);
      appendExecutionEvidence(evidence, 'hidden_test', ht.description, { ...r, stderr });
      const envInfo = detectEnvironmentError(`${r.stdout}\n${stderr}`);
      if (envInfo.isEnv) {
        envErrorReason = envInfo.reason ?? 'test environment unavailable';
        break; // 根因确定后不再浪费后续冷容器测试，也不制造更多污染证据。
      }
      if (r.timedOut && executionPolicy?.coldStartTimeoutIsEnvironmentError === true) {
        envErrorReason = 'network-required cold container test timed out';
        break;
      }
    }

    // 3b. 环境/测试基础设施故障：test_pass 不可信 → 整题标记隔离，不计入维度均值
    if (envErrorReason !== null) {
      axisScores.test_pass = 0;
      axisEvidence.test_pass = 'unmeasured';
      evidence.push(`ENVIRONMENT_ERROR: ${envErrorReason} — harness 故障，非模型错误，已隔离（unmeasured）`);
    } else {
      // 4. test_pass 得分（通过率）
      const passed = results.filter((r) => r.passed).length;
      axisScores.test_pass = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;
      axisEvidence.test_pass = 'rule';
    }

    // 5. api_stability：入口函数签名是否保留（启发式：替换文件中仍含 functionName）
    const fnName = req.functionName;
    if (fnName) {
      const initialEntry = initialFiles.map((f) => f.content).join('\n');
      const replacedEntry = Object.values(replacements).join('\n');
      const initialHasFn = initialEntry.includes(fnName);
      // 入口函数保留 = 初始文件里有，且（未被替换的文件里仍有 或 替换文件里仍有）
      const fnStillPresent = (initialEntry + '\n' + replacedEntry).includes(fnName);
      axisScores.api_stability = initialHasFn && fnStillPresent ? 100 : (fnStillPresent ? 50 : 0);
      axisEvidence.api_stability = 'rule';
      evidence.push('api_stability: 入口函数 ' + fnName + ' 保留=' + fnStillPresent);
    }

    // 6. static_signals：关键词命中（错误处理/性能/重构质量由 LLM judge 复核）
    const keywords = req.explanationKeywords ?? [];
    if (keywords.length > 0) {
      const hit = keywords.filter((k) => modelOutput.includes(k)).length;
      axisScores.static_signals = Math.round((hit / keywords.length) * 100);
      axisEvidence.static_signals = 'rule';
    }

    // 7. scope_discipline：模型是否改动过多文件（简单启发式）
    const changedCount = Object.keys(replacements).length;
    axisScores.scope_discipline = changedCount <= initialFiles.length ? 100 : Math.max(0, 100 - (changedCount - initialFiles.length) * 20);
    axisEvidence.scope_discipline = 'rule';

    // 8. 加权总分
    const weights = (scenario.scoring?.weights ?? {}) as Record<string, number>;
    const defaultWeights: Record<string, number> = {
      test_pass: 0.25,
      api_stability: 0.15,
      static_signals: 0.30,
      output_completeness: 0.15,
      scope_discipline: 0.15,
    };
    const w = Object.keys(defaultWeights).length > 0 && Object.keys(weights).length > 0 ? weights : defaultWeights;
    let sum = 0;
    let wsum = 0;
    for (const [axis, weight] of Object.entries(w)) {
      const score = axisScores[axis];
      if (score === undefined) continue;
      sum += score * weight;
      wsum += weight;
    }
    const totalScore = wsum > 0 ? Math.round(sum / wsum) : 0;

    return {
      axisScores,
      axisEvidence,
      totalScore,
      safetyLevel: 'safe',
      evidence,
      environmentError: envErrorReason !== null,
    } as Partial<ScenarioResult>;
  },
};
