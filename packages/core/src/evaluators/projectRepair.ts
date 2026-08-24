// ============================================================
// Project Repair 评分器 v1.0（多文件工作区 + 容器执行测试套件）
// 场景 requirements：
//   files: [{path, content}]             —— 模型可见的初始工作区
//   hiddenTestFiles?: [{path, content}]  —— grader 注入的隐藏测试文件（模型不可见）
//   hiddenTests?: [{description, script}] —— 隐藏测试执行命令
//   publicTests?: [{description, script}] —— 公开测试执行命令
//   functionName?: string                —— 入口函数（api_stability 用）
//   explanationKeywords?: string[]       —— 静态信号关键词
//   image?: string                       —— 覆盖默认容器镜像
// 模型输出：多文件「完整内容」，每个文件一个代码块，前一行用
//   「### file: <path>」标注路径。未标注路径的代码块视为对全部文件
//   的增量描述，忽略。
// 评分轴：test_pass(25) + api_stability(15) + static_signals(30)
//          + output_completeness(15) + scope_discipline(15)，权重可被
//          scenario.scoring.weights 覆盖。
// ============================================================

import type { Scenario, ScenarioResult, ModelResponse, OutputMetadata, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { runInContainer, isDockerAvailable } from '../execution/index.js';

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
}

/** 从模型输出解析「### file: <path> + 代码块」→ {path: content} */
function parseFileBlocks(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  // 匹配行首 ### file: path（可选 ```lang 紧随）
  const markerRe = /###\s*file\s*:\s*([^\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(output)) !== null) {
    const path = m[1].trim();
    const afterMarker = m.index + m[0].length;
    // 找紧随其后的代码块
    const fenceRe = /```[\w+-]*\s*\n([\s\S]*?)```/;
    fenceRe.lastIndex = afterMarker;
    // 用 slice 找下一个 fence
    const rest = output.substring(afterMarker);
    const fm = rest.match(/```[\w+-]*\s*\n([\s\S]*?)```/);
    if (fm) {
      result[path] = fm[1].replace(/\n$/, '');
    }
  }
  return result;
}

/** 物化工作区：初始文件 + 模型替换 + 隐藏测试文件 → ContainerFile[] */
function buildWorkspaceFiles(
  initial: { path: string; content: string }[],
  replacements: Record<string, string>,
  hidden: { path: string; content: string }[],
) {
  const map = new Map<string, string>();
  for (const f of initial) map.set(f.path, f.content);
  for (const [path, content] of Object.entries(replacements)) map.set(path, content);
  for (const f of hidden) map.set(f.path, f.content);
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

/** 在容器中跑单个测试脚本（脚本是 shell 命令，如 'pytest -q tests/hidden/x.py'） */
async function runScript(
  image: string,
  files: { path: string; content: string }[],
  script: string,
  timeoutMs: number,
  opts?: { pg?: boolean },
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
    networkDisabled: false,  // 长任务脚本需 pip/npm install 依赖
    readOnly: false,  // 长任务需要写文件（DB/缓存/产物）
    user,
    env: { HOME: '/tmp' },  // 非 root(65534) 下 HOME 默认 /nonexistent，dotnet/go 需要可写 HOME
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
  version: '1.0.0',

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

    // 1. 解析模型输出的多文件替换
    const replacements = parseFileBlocks(modelOutput);
    axisScores.output_completeness = Object.keys(replacements).length > 0 ? 100 : 0;
    axisEvidence.output_completeness = 'rule';
    evidence.push('解析到 ' + Object.keys(replacements).length + ' 个文件替换');

    // 2. 物化工作区
    const workspaceFiles = buildWorkspaceFiles(initialFiles, replacements, hiddenFiles);

    // 3. 跑隐藏测试脚本
    if (!(await isDockerAvailable())) {
      evidence.push('Docker 不可用，跳过容器测试');
      return {
        axisScores: { test_pass: 0, output_completeness: axisScores.output_completeness ?? 0 },
        axisEvidence: { test_pass: 'unmeasured', output_completeness: 'rule' },
        totalScore: 0,
        safetyLevel: 'safe',
        evidence,
      } as Partial<ScenarioResult>;
    }

    const results: ScriptRunResult[] = [];
    for (const ht of hiddenTests) {
      if (!ht.script || !ht.script.trim()) {
        evidence.push('跳过无 script 的测试: ' + ht.description);
        continue;
      }
      const isSql = lang === 'sql' || lang === 'postgresql';
      const r = await runScript(image, workspaceFiles, ht.script, isSql ? 180000 : 120000, { pg: isSql });
      results.push(r);
      evidence.push((r.passed ? 'PASS' : 'FAIL') + ' [' + ht.description + '] exit=' + r.exitCode + (r.passed ? '' : ' | ' + (r.stderr || r.stdout || '').replace(/\r?\n/g, ' ').slice(0, 300)));
    }

    // 4. test_pass 得分（通过率）
    const passed = results.filter((r) => r.passed).length;
    axisScores.test_pass = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;
    axisEvidence.test_pass = 'rule';

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
    } as Partial<ScenarioResult>;
  },
};
