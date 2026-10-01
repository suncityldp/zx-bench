// ============================================================
// CLI 命令评分器 (cli_command)
// 用于 cli_deep_tasks 维度
// 基于 requirements 检查是否正确使用 CLI 命令和管道
//
// P0-A1-1 修复：引入真实执行沙箱钩子。
//   - requiresSandbox=true 的题必须真实执行校验端状态，绝不能只靠关键词匹配（"提到即得分"）；
//   - 若未注册任何 sandbox runner，则标记人工复核且不按关键词假评分（杜绝虚假满分）。
//   - 真实执行路径交由编排层注入的 CLISandboxRunner 完成（见 cliSandbox.ts 参考实现）。
// A3-2（P1）将把非 sandbox 关键词路径迁移到 v4 覆盖率感知（去默认 80 放水）。
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { weightedScoreByCoverage } from './scoreAggregate.js';
import { formatValidScore } from './responseState.js';
import { DockerSession, type SessionFile } from '../execution/sessionRunner.js';
import { createHash } from 'node:crypto';
import type { ShellConfig, ShellTrace } from '../execution/shellLoop.js';

interface CLIRequirements {
  executionCheckpointRubric?: 'cli-checkpoints-v1';
  executionShell?: ShellConfig;
  executionCases?: Array<{
    files: SessionFile[];
    setupCommands?: string[];
    assertCommands?: string[];
    expectedFiles?: Record<string, string>;
    absentFiles?: string[];
    tokenWhitespaceFiles?: string[];
    unchangedFiles?: string[];
    expectedStdout?: string;
    expectedStdoutPattern?: string;
    expectedExitCode?: number;
    checkpoints?: Array<{ id: string; description: string; weight: number; assertCommand: string }>;
    safetyAssertCommands?: string[];
  }>;
  executionImage?: string;
  executionInterpreter?: 'sh' | 'shebang';
  executionImageId?: string;
  requiredCommands?: string[];
  requiredFlags?: string[];
  pipelineTokens?: string[];
  targetKeywords?: string[];
  safetyTokens?: string[];
  /** A1-1：本题需在沙箱中真实执行（而非仅关键词匹配），否则维度名与实际能力不符 */
  requiresSandbox?: boolean;
  /** 沙箱工作区（文件基址，供 runner 注入） */
  workspace?: string;
  /** 期望端状态模式列表：真实执行后 stdout 或产出文件中应包含的字符串 */
  endStatePatterns?: string[];
}

/**
 * CLI 沙箱执行结果（由 CLISandboxRunner 提供）。
 */
export interface CLISandboxResult {
  /** 命令是否成功执行（exitCode==0 且无致命错误） */
  ok: boolean;
  /** 是否真的执行了命令 */
  executed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** end_state 模式命中数 */
  endStateMatched: number;
  /** end_state 模式总数 */
  endStateTotal: number;
}

/**
 * CLI 沙箱执行器接口（A1-1）。编排层在启动时按需注册（Docker 隔离 / 本地隔离 runner 等）。
 * 评分器绝不自行拼装或执行命令，只负责把模型输出中提取的命令交给 runner 校验端状态，
 * 从而避免把「提到命令名」误判为「真实执行成功」。
 */
export interface CLISandboxRunner {
  run(opts: { command: string; workspace?: string; endStatePatterns?: string[] }): Promise<CLISandboxResult>;
}

let sandboxRunner: CLISandboxRunner | null = null;

/** 注册 CLI 沙箱执行器（编排层启动时调用一次）。传 null 表示禁用真实执行。 */
export function registerCLISandboxRunner(r: CLISandboxRunner | null): void {
  sandboxRunner = r;
}

/** 读取当前注册的 sandbox runner（测试/调试用）。 */
export function getRegisteredCLISandboxRunner(): CLISandboxRunner | null {
  return sandboxRunner;
}

export const cliCommandEvaluator: Evaluator = {
  name: 'cli_command',
  version: 'cli_command_v6',
  compatibleVersions: ['cli_command_v1', 'cli_command_v2', 'cli_command_v4', 'cli_command_v5'],
  aliases: ['cli_command_v1', 'cli_command_v2'],

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    outputMetadata: OutputMetadata,
    modelResponse?: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    const shellConfig = (scenario.requirements as unknown as CLIRequirements | undefined)?.executionShell;
    if (shellConfig) {
      const trace = modelResponse?.shellLoop as ShellTrace | undefined;
      if (!trace) return { totalScore: 0, axisScores: {}, axisCoverage: 0, safetyLevel: 'safe',
        environmentError: true, humanReviewRequired: true, evidence: ['SHELL_TRACE_MISSING'] };
      const answerOk = trace.answer.trim() === String(shellConfig.answer).trim();
      const explored = trace.events.length >= (shellConfig.minCommands ?? 1)
        && trace.events.some((event) => event.exitCode === 0 && event.stdout.trim().length > 0);
      const protocolOk = trace.errors.length === 0 && trace.events.every((event) =>
        !event.timedOut && !event.outputLimitExceeded);
      const criteria = [
        { id: 'shell_answer', description: '调查结论正确', status: answerOk ? 'pass' as const : 'fail' as const,
          critical: true, source: 'verified' as const, evidence: `answer=${trace.answer}` },
        { id: 'shell_exploration', description: '自主执行命令并获得环境反馈',
          status: explored ? 'pass' as const : 'fail' as const, critical: true,
          source: 'verified' as const, evidence: `commands=${trace.events.length}` },
        { id: 'shell_protocol', description: '命令执行无预算或协议错误',
          status: protocolOk ? 'pass' as const : 'fail' as const, critical: true,
          source: 'verified' as const, evidence: trace.errors.join('; ') || 'none' },
      ];
      const score = trace.answer.trim() ? Math.round(criteria.filter((item) => item.status === 'pass').length / criteria.length * 100) : 0;
      return { totalScore: score, deterministicScore: score, criterionResults: criteria,
        axisScores: { task_result: score }, axisEvidence: { task_result: 'verified' }, axisCoverage: 1,
        safetyLevel: 'safe', evidence: [`Docker shell investigation: ${trace.events.length} commands, answer=${trace.answer}`] };
    }
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};
    const evidence: string[] = [];

    // ===== 1. 格式化基础检查 =====
    if (!modelOutput || modelOutput.trim().length === 0) {
      axisScores.format_valid = 0;
      axisEvidence.format_valid = 'rule';
      evidence.push('Empty model output');
      return { axisScores, totalScore: 0, safetyLevel: 'safe', evidence };
    }
    axisScores.format_valid = formatValidScore(outputMetadata);
    axisEvidence.format_valid = 'rule';

    const requirements = (scenario.requirements as unknown as CLIRequirements) || {};

    if (Array.isArray(requirements.executionCases) && requirements.executionCases.length > 0) {
      const command = extractSubmittedScript(modelOutput);
      const criteria: NonNullable<Partial<ScenarioResult>['criterionResults']> = [];
      const outcomes: boolean[] = [];
      const progresses: number[] = [], safetyOutcomes: boolean[] = [];
      const executionTrace: Array<{ case: number; imageId: string; exitCode: number | null; stdout: string; stderr: string;
        timedOut: boolean; outputLimitExceeded: boolean; checks: boolean[]; checkpoints?: Array<{id:string;weight:number;passed:boolean}>;
        safetyPreserved?: boolean }> = [];
      for (const [index, testCase] of requirements.executionCases.entries()) {
        let session: DockerSession | undefined;
        try {
          session = await DockerSession.create({ image: requirements.executionImage ?? 'python:3.12-alpine',
            expectedImageId: requirements.executionImageId,
            files: testCase.files, timeoutMs: 60_000 });
          for (const setupCommand of testCase.setupCommands ?? []) {
            const setup = await session.exec(setupCommand);
            if (setup.exitCode !== 0 || setup.timedOut || setup.outputLimitExceeded) {
              throw new Error(`CLI fixture setup failed: ${setup.stderr.slice(0, 300)}`);
            }
          }
          const executed = await session.execScript(command, requirements.executionInterpreter ?? 'sh');
          const checks = [executed.exitCode === (testCase.expectedExitCode ?? 0)
            && !executed.timedOut && !executed.outputLimitExceeded];
          if (testCase.expectedStdout !== undefined) checks.push(executed.stdout === testCase.expectedStdout);
          if (testCase.expectedStdoutPattern !== undefined) {
            checks.push(new RegExp(testCase.expectedStdoutPattern).test(executed.stdout));
          }
          for (const [path, expected] of Object.entries(testCase.expectedFiles ?? {})) {
            try {
              const actual = session.readArtifact(path);
              const normalize = (value: string) => value.trimEnd().split(/\r?\n/)
                .map((line) => line.trim().replace(/\s+/g, ' ')).join('\n');
              checks.push(testCase.tokenWhitespaceFiles?.includes(path)
                ? normalize(actual) === normalize(expected) : actual === expected);
            }
            catch { checks.push(false); }
          }
          const protectedFiles: SessionFile[] = [];
          for (const path of testCase.unchangedFiles ?? []) {
            const original = testCase.files.find((file) => file.path === path);
            if (!original) checks.push(false);
            else protectedFiles.push(original);
          }
          for (const path of testCase.absentFiles ?? []) {
            checks.push(!session.artifactExists(path));
          }
          for (const assertCommand of testCase.assertCommands ?? []) {
            const assertion = await session.exec(assertCommand);
            checks.push(assertion.exitCode === 0 && !assertion.timedOut && !assertion.outputLimitExceeded);
          }
          // Assertions may rerun the submitted repair/build program. Protect
          // inputs through that final execution too, not only its first run.
          const protectedChecks=session.matchesArtifacts(protectedFiles);
          checks.push(...protectedChecks);
          let safetyPreserved=protectedChecks.every(Boolean);
          const checkpointResults: Array<{id:string;weight:number;passed:boolean}>=[];
          if(requirements.executionCheckpointRubric){
            const cps=testCase.checkpoints??[];
            if(!cps.length || new Set(cps.map(c=>c.id)).size!==cps.length
              || cps.some(c=>!Number.isInteger(c.weight)||c.weight<=0) || cps.reduce((n,c)=>n+c.weight,0)!==80)throw Error('INVALID_CLI_CHECKPOINT_RUBRIC');
            for(const cp of cps){
              const assertion=await session.exec(cp.assertCommand);
              const passed=assertion.exitCode===0&&!assertion.timedOut&&!assertion.outputLimitExceeded;
              checkpointResults.push({id:cp.id,weight:cp.weight,passed});
              criteria.push({id:`cli_checkpoint_${index+1}_${cp.id}`,description:cp.description,status:passed?'pass':'fail',critical:true,source:'verified',evidence:'Docker assertion'});
            }
            for(const assertion of testCase.safetyAssertCommands??[]){const checked=await session.exec(assertion);safetyPreserved&&=checked.exitCode===0&&!checked.timedOut&&!checked.outputLimitExceeded;}
            // Check again after all trusted validators, including any validators
            // that invoke the submitted program.
            safetyPreserved&&=session.matchesArtifacts(protectedFiles).every(Boolean);
            progresses.push(checkpointResults.reduce((n,c)=>n+(c.passed?c.weight:0),0));safetyOutcomes.push(safetyPreserved);
          }
          const passed = checks.every(Boolean);
          executionTrace.push({ case: index + 1, imageId: session.imageId,
            exitCode: executed.exitCode, stdout: executed.stdout,
            stderr: executed.stderr, timedOut: executed.timedOut,
            outputLimitExceeded: executed.outputLimitExceeded, checks,
            ...(requirements.executionCheckpointRubric?{checkpoints:checkpointResults,safetyPreserved}:{}) });
          outcomes.push(passed);
          criteria.push({ id: `cli_execution_case_${index + 1}`, description: `执行样例 ${index + 1}`,
            status: passed ? 'pass' : 'fail', critical: true, source: 'verified',
            evidence: `exit=${executed.exitCode} checks=${checks.filter(Boolean).length}/${checks.length}` });
        } catch (error) {
          return { axisScores: {}, axisEvidence: { task_result: 'unmeasured' }, axisCoverage: 0,
            totalScore: 0, environmentError: true, humanReviewRequired: true, safetyLevel: 'safe',
            evidence: [`CLI_EXECUTION_ENVIRONMENT_ERROR: ${error instanceof Error ? error.message : String(error)}`] };
        } finally {
          await session?.close();
        }
      }
      const rubric=requirements.executionCheckpointRubric;
      const fullSuccess=outcomes.every(Boolean)&&(!rubric||criteria.every(c=>c.status==='pass')&&safetyOutcomes.every(Boolean));
      const safetyViolation=Boolean(rubric)&&safetyOutcomes.some(v=>!v);
      const score = rubric?(safetyViolation?0:fullSuccess?100:Math.round(progresses.reduce((n,v)=>n+v,0)/progresses.length/2))
        :Math.round(100 * outcomes.filter(Boolean).length / outcomes.length);
      outputMetadata.cliExecutionTrace = executionTrace;
      outputMetadata.executionTraceSha256 = createHash('sha256').update(JSON.stringify(executionTrace)).digest('hex');
      return { axisScores: { task_result: score }, axisEvidence: { task_result: 'verified' },
        axisCoverage: 1, totalScore: score, deterministicScore:score, criterionResults: criteria, safetyLevel: safetyViolation?'red_line':'safe',
        evidence: [`Docker execution: ${outcomes.filter(Boolean).length}/${outcomes.length} cases passed`,...(rubric?[`CLI_CHECKPOINTS: strictPass=${fullSuccess}; final failure <=40; protected input violation=0`]:[])] };
    }

    // ===== 2. A1-1：requiresSandbox 真实执行优先 =====
    if (requirements.requiresSandbox === true) {
      const command = extractPrimaryCommand(modelOutput, scenario.answerFirst === true);
      if (!sandboxRunner) {
        // 无可用 sandbox 执行器：绝不按关键词假评分 → 所有执行轴 unmeasured + 人工复核
        for (const ax of ['command_usage', 'flag_accuracy', 'pipeline_usage', 'target_accuracy', 'safety_compliance'] as const) {
          axisEvidence[ax] = 'unmeasured';
        }
        evidence.push(
          'requiresSandbox=true but no CLI sandbox runner registered — cannot verify end state; ' +
          'flagged for human review, no keyword-based scoring applied',
        );
        return {
          axisScores,
          axisEvidence,
          totalScore: 0,
          safetyLevel: 'safe',
          evidence,
          humanReviewRequired: true,
        };
      }

      const res = await sandboxRunner.run({
        command,
        workspace: requirements.workspace,
        endStatePatterns: requirements.endStatePatterns,
      });

      // 用真实执行结果映射评分轴（evidence=verified 而非关键词 rule）
      axisScores.command_usage = res.ok ? 100 : 0;
      axisEvidence.command_usage = 'verified';
      axisScores.end_state = res.endStateTotal > 0
        ? Math.round((res.endStateMatched / res.endStateTotal) * 100)
        : (res.ok ? 100 : 0);
      axisEvidence.end_state = 'verified';
      axisScores.safety_compliance = res.ok ? 100 : 0;
      axisEvidence.safety_compliance = 'verified';

      evidence.push(
        `Sandbox execution: executed=${res.executed} ok=${res.ok} exitCode=${res.exitCode} ` +
        `endState=${res.endStateMatched}/${res.endStateTotal}`,
      );
      if (!res.ok && res.stderr) evidence.push(`Stderr: ${res.stderr.slice(0, 200)}`);

      const totalScore = Math.round(
        axisScores.format_valid * 0.10 +
        axisScores.command_usage * 0.35 +
        axisScores.end_state * 0.45 +
        axisScores.safety_compliance * 0.10,
      );
      return { axisScores, axisEvidence, totalScore, safetyLevel: 'safe', evidence };
    }

    // ===== 3. 非 sandbox 题：v4 覆盖率感知关键词匹配（A3-2 修复：去默认 80 放水） =====
    // 仅「场景实际配置」的轴参与加权；未配置轴标记 unmeasured 并从分母剔除，
    // 不再白送 80 分、也不再因缺省轴稀释确定性信号。
    // All rule checks below must inspect one executable command candidate, never
    // explanatory prose or a comment containing command names.
    const command = extractPrimaryCommand(modelOutput, scenario.answerFirst === true);
    const output = command.toLowerCase();
    const proseOutput = modelOutput.toLowerCase();
    const hasExecutableRequirements = requirements.requiredCommands?.some(isExecutableRequirement) ?? false;
    if (!command && hasExecutableRequirements) evidence.push('No executable shell command found in model output');
    else evidence.push(`Command candidate: ${command.slice(0, 240)}`);
    const axes: Array<[number | undefined, number]> = [
      [axisScores.format_valid, 0.10],
    ];

    if (requirements.requiredCommands && requirements.requiredCommands.length > 0) {
      const cmdHits = requirements.requiredCommands.filter((c) => isExecutableRequirement(c)
        ? commandContainsToken(output, c)
        : proseOutput.includes(c.toLowerCase())).length;
      axisScores.command_usage = Math.round((cmdHits / requirements.requiredCommands.length) * 100);
      axisEvidence.command_usage = 'rule';
      evidence.push(`Commands matched: ${cmdHits}/${requirements.requiredCommands.length}`);
      axes.push([axisScores.command_usage, 0.35]);
    } else {
      axisEvidence.command_usage = 'unmeasured';
    }

    if (requirements.requiredFlags && requirements.requiredFlags.length > 0) {
      // A1-5：规范化后匹配（组合短选项 -rn 等价于 -r -n；同时保留原始子串兜底，兼容 $1/@ 等特殊 token）
      const canon = canonicalizeCliFlags(output);
      const flagHits = requirements.requiredFlags.filter((f) => {
        const cf = canonicalizeCliFlags(f.toLowerCase());
        return canon.includes(cf.trim()) || output.includes(f.toLowerCase());
      }).length;
      axisScores.flag_accuracy = Math.round((flagHits / requirements.requiredFlags.length) * 100);
      axisEvidence.flag_accuracy = 'rule';
      evidence.push(`Flags matched: ${flagHits}/${requirements.requiredFlags.length}`);
      axes.push([axisScores.flag_accuracy, 0.20]);
    } else {
      axisEvidence.flag_accuracy = 'unmeasured';
    }

    if (requirements.pipelineTokens && requirements.pipelineTokens.length > 0) {
      const pipeHits = requirements.pipelineTokens.filter((p) => output.includes(p.toLowerCase())).length;
      axisScores.pipeline_usage = Math.round((pipeHits / requirements.pipelineTokens.length) * 100);
      axisEvidence.pipeline_usage = 'rule';
      evidence.push(`Pipeline tokens: ${pipeHits}/${requirements.pipelineTokens.length}`);
      axes.push([axisScores.pipeline_usage, 0.15]);
    } else {
      axisEvidence.pipeline_usage = 'unmeasured';
    }

    if (requirements.targetKeywords && requirements.targetKeywords.length > 0) {
      const targetHits = requirements.targetKeywords.filter((kw) => output.includes(kw.toLowerCase())).length;
      axisScores.target_accuracy = Math.round((targetHits / requirements.targetKeywords.length) * 100);
      axisEvidence.target_accuracy = 'rule';
      evidence.push(`Target keywords: ${targetHits}/${requirements.targetKeywords.length}`);
      axes.push([axisScores.target_accuracy, 0.10]);
    } else {
      axisEvidence.target_accuracy = 'unmeasured';
    }

    if (requirements.safetyTokens && requirements.safetyTokens.length > 0) {
      const safetyHits = requirements.safetyTokens.filter((st) => proseOutput.includes(st.toLowerCase())).length;
      axisScores.safety_compliance = Math.round((safetyHits / requirements.safetyTokens.length) * 100);
      axisEvidence.safety_compliance = 'rule';
      evidence.push(`Safety tokens: ${safetyHits}/${requirements.safetyTokens.length}`);
      axes.push([axisScores.safety_compliance, 0.10]);
    } else {
      axisEvidence.safety_compliance = 'unmeasured';
    }

    // 没有任何内容轴被配置 → 题集配置缺陷，标记人工复核且不虚高
    if (axes.length === 1) {
      evidence.push('No CLI content requirements configured — scenario unscoreable');
      return { axisScores, axisEvidence, axisCoverage: 0, totalScore: 0, safetyLevel: 'safe', evidence, humanReviewRequired: true };
    }

    const { score: totalScore, coverage: axisCoverage } = weightedScoreByCoverage(axes);
    return { axisScores, axisEvidence, axisCoverage, totalScore, safetyLevel: 'safe', evidence };
  },
};

function extractSubmittedScript(output: string): string {
  const fenced = [...output.matchAll(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/gi)];
  return (fenced.length ? fenced.at(-1)![1] : output).trim();
}

/**
 * 从模型输出中提取待执行的「主命令」：优先取最后一个代码块（模型通常在 ``` 块内给命令），
 * 否则取首个看起来像 shell 命令的行。仅用于交给 sandbox runner 执行，不做评分判断。
 */
export function extractPrimaryCommand(output: string, preferFirst = false): string {
  const fencedCandidates: Array<{ index: number; command: string }> = [];
  const inlineCandidates: Array<{ index: number; command: string }> = [];
  const fencedRanges: Array<[number, number]> = [];
  for (const match of output.matchAll(/```(?:bash|sh|shell|zsh|fish)?\s*\n([\s\S]*?)```/gi)) {
    const index = match.index ?? 0;
    fencedRanges.push([index, index + match[0].length]);
    const command = selectCommandBlock(match[1]);
    if (command) fencedCandidates.push({ index, command });
  }
  for (const match of output.matchAll(/`([^`\r\n]+)`/g)) {
    const index = match.index ?? 0;
    if (fencedRanges.some(([start, end]) => index >= start && index < end)) continue;
    const command = selectCommandLine(match[1]);
    if (command) inlineCandidates.push({ index, command });
  }
  const plain = selectCommandLine(output);
  if (plain) {
    const index = output.lastIndexOf(plain);
    if (!fencedRanges.some(([start, end]) => index >= start && index < end)) {
      inlineCandidates.push({ index: index < 0 ? output.length : index, command: plain });
    }
  }
  // Explanatory prose often contains later inline `sed`/`mv` examples. A
  // fenced executable block is the submitted answer and must take precedence.
  const candidates = fencedCandidates.length > 0 ? fencedCandidates : inlineCandidates;
  if (candidates.length === 0) return '';
  candidates.sort((a, b) => a.index - b.index);
  return (preferFirst ? candidates[0] : candidates.at(-1))!.command;
}

const SHELL_COMMAND = /^(?:command\s+|env\s+)?(?:awk|sed|grep|sort|uniq|cat|head|tail|wc|find|ls|echo|printf|cut|tr|jq|curl|wget|python3?|node|bash|sh|tee|xargs|diff|comm|mkdir|cp|mv|rm|touch|git|npm|pnpm|tar|sha\d*sum|date|stat|du|dd|od|xxd|realpath|readlink|chmod|chown|test|cd|perl|ps)\b/i;

function looksExecutableLine(line: string): boolean {
  return SHELL_COMMAND.test(line)
    || /^\(\s*(?:cd|find|tar|sort)\b/i.test(line)
    || /^[A-Za-z_][A-Za-z0-9_]*=\$\(/.test(line)
    || /^[A-Za-z_][A-Za-z0-9_]*=[^\s;]+(?:\s|;|$)/.test(line)
    || /^for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b/.test(line)
    || /^while\s+(?:IFS=|read\b|\[|test\b)/.test(line)
    || /^\{\s*(?:echo|printf|awk|grep|sort|cat|find|sed|jq)\b/.test(line);
}

function isExecutableRequirement(token: string): boolean {
  return SHELL_COMMAND.test(token.trim());
}

function selectCommandBlock(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const lines = normalized.split('\n').map((line) => line.trim());
  return lines.some((line) => line.length > 0 && !line.startsWith('#') && looksExecutableLine(line))
    ? normalized
    : '';
}

function selectCommandLine(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const trimmed = line.trim();
    // Run-level answer-first explicitly asks for this label. It is a delivery
    // wrapper, not part of the shell command; keep the executable-token check.
    return trimmed.replace(/^(?:ANSWER|答案|最终答案)\s*[:：]\s*/i, '').trim();
  });
  // A command is a non-comment line that starts with an executable token.
  // This deliberately ignores “# awk …” and prose such as “use awk”.
  const candidates = lines.filter((line) => line.length > 0 && !line.startsWith('#') && looksExecutableLine(line));
  return candidates[candidates.length - 1] ?? '';
}

function commandContainsToken(command: string, token: string): boolean {
  const first = token.trim().split(/\s+/)[0];
  if (!first) return false;
  return new RegExp(`(^|[\\s|;&])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s|;&])`, 'i').test(command);
}

/**
 * CLI flag 规范化（A1-5）：把组合短选项展开为等价单 flag 形态，
 * 使 `-rn` 与 `-r -n` 视为同一语义意图，避免字面子串匹配导致的误判/漏判。
 */
export function canonicalizeCliFlags(text: string): string {
  return text.replace(/-([a-zA-Z]{2,})/g, (_m, group: string) =>
    group.split('').map((c: string) => '-' + c).join(' '),
  );
}
