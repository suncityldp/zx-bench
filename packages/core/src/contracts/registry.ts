// ============================================================
// 场景契约注册表（Phase 1：grader@version → 契约）
// 单一事实源：每个 grader 的 requirements 消费字段、契约声明字段、
// 能力边界（支持的 format/language/response mode）。
// evaluator 修改字段消费时必须同步更新这里，避免与 health-check 等
// 手写副本再次分叉。
// ============================================================

import type { ScenarioCapabilities } from '@zxbench/types';

export interface GraderContract {
  /** 评分器名（scenario.grader） */
  grader: string;
  /** 评分器版本（scenario.graderVersion） */
  version: string;
  /** 归属维度 */
  dimension: string;
  /** evaluator 实际消费的 requirements 字段 */
  consumedFields: string[];
  /** 契约声明的合法字段（consumed + 题库已知但尚未消费的待支持字段） */
  declaredFields: string[];
  /** 动态字段名：字段名本身是数据（如 safety 的 should_* 前缀、data_extraction 的任意 key） */
  dynamicFieldPatterns?: RegExp[];
  /** 必需字段：缺失 → error */
  requiredFields: string[];
  capabilities: ScenarioCapabilities;
  /** grader 名别名（历史遗留，如 CR2 pack 的 code_repair_v3） */
  aliases?: string[];
}

export const GRADER_CONTRACTS: Record<string, GraderContract> = {
  // ---- 推理数学：精确答案行 ----
  exact_answer_line: {
    grader: 'exact_answer_line',
    version: 'exact_answer_v2',
    dimension: 'reasoning_math',
    consumedFields: ['answer'],
    declaredFields: ['answer', 'acceptedVariants', 'answerGrammar', 'answerType', 'units', 'validUntil'],
    requiredFields: ['answer'],
    capabilities: {},
  },

  // ---- 结构化输出：schema_compliance（format 目前从 scenario.schema/grader 推，未读 requirements.format —— 已知缺陷） ----
  schema_compliance: {
    grader: 'schema_compliance',
    version: 'schema_compliance_v2',
    dimension: 'structured_output',
    consumedFields: [],
    declaredFields: ['format', 'output_policy', 'requiredFields', 'crossFieldRules'],
    requiredFields: ['format'],
    capabilities: {
      supportedFormats: ['json', 'csv', 'yaml', 'sql', 'xml', 'html', 'mermaid', 'markdown', 'toml', 'regex'],
    },
  },

  // ---- 数据抽取：requirements 的每个字段都是「字段名 → 期望值」 ----
  json_atomic_fields: {
    grader: 'json_atomic_fields',
    version: 'json_atomic_v2',
    dimension: 'data_extraction',
    consumedFields: [],
    declaredFields: [],
    dynamicFieldPatterns: [/.*/],
    requiredFields: [],
    capabilities: {},
  },

  // ---- 指令遵循 ----
  instruction_checklist: {
    grader: 'instruction_checklist',
    version: 'instruction_checklist_v4',
    dimension: 'instruction_following',
    consumedFields: ['constraints'],
    declaredFields: ['constraints'],
    requiredFields: ['constraints'],
    capabilities: {},
  },

  // ---- 安全权限：canary_authority ----
  canary_authority: {
    grader: 'canary_authority',
    version: 'canary_authority_v3',
    dimension: 'safety_authority',
    consumedFields: ['positive_keywords'],
    declaredFields: ['positive_keywords', 'forbidden_actions', 'requiredSafeActions', 'confirmationRequiredBefore'],
    dynamicFieldPatterns: [/^should_/, /^forbidden_/, /^required_/, /^confirmation_/],
    requiredFields: [],
    capabilities: {},
  },

  // ---- 幻觉抵抗 ----
  hallucination_resistance: {
    grader: 'hallucination_resistance',
    version: 'hallucination_v3',
    dimension: 'hallucination_resistance',
    consumedFields: [
      'answerability', 'answerKeywords', 'answer', 'correctionKeywords',
      'citationTrap', 'fabricationAnchors', 'referenceAnswer', 'validUntil',
    ],
    declaredFields: [
      'answerability', 'answerKeywords', 'answer', 'correctionKeywords',
      'citationTrap', 'fabricationAnchors', 'referenceAnswer', 'validUntil',
    ],
    requiredFields: ['answerability'],
    capabilities: {},
  },

  // ---- 工具调用 / CLI 工作流：tool_call_trace ----
  tool_call_trace: {
    grader: 'tool_call_trace',
    version: 'tool_trace_v4',
    dimension: 'tool_cli_workflow',
    consumedFields: [
      'tool', 'params', 'commands', 'should_call', 'should_call_first',
      'should_not_call', 'should_not_directly', 'should_not_call_any',
      'minimal_calls', 'require_patterns',
    ],
    declaredFields: [
      'tool', 'params', 'commands', 'should_call', 'should_call_first',
      'should_not_call', 'should_not_directly', 'should_not_call_any',
      'minimal_calls', 'require_patterns',
      // 题库已写但 evaluator 尚未消费的字段（待 Phase 3 迁移）
      'sequence', 'must_call', 'calls', 'orderMatters', 'must_not', 'allowExtra',
      'dependencies', 'conditional', 'parallel', 'loop', 'recovery', 'end_state', 'output_file',
    ],
    requiredFields: [],
    capabilities: { supportedResponseModes: ['plan'] },
  },

  // ---- 智能体工作流：agent_trace ----
  agent_trace: {
    grader: 'agent_trace',
    version: 'agent_trace_v5',
    dimension: 'agent_workflow',
    consumedFields: ['expectedActions', 'expectedStateChanges', 'completionKeywords', 'planningKeywords'],
    declaredFields: [
      'expectedActions', 'expectedStateChanges', 'completionKeywords', 'planningKeywords',
      'forbiddenActions', 'safetyCapActions', 'stateFixture', 'responseMode',
    ],
    requiredFields: [],
    capabilities: { supportedResponseModes: ['plan'] },
  },

  // ---- CLI 深度任务：cli_command（含 6 道 requiresSandbox 实地调查题） ----
  cli_command: {
    grader: 'cli_command',
    version: 'cli_command_v1',
    dimension: 'cli_deep_tasks',
    consumedFields: ['requiredCommands', 'requiredFlags', 'pipelineTokens', 'targetKeywords', 'safetyTokens'],
    declaredFields: [
      'requiredCommands', 'requiredFlags', 'pipelineTokens', 'targetKeywords', 'safetyTokens',
      'disciplineCapPatterns', 'requiresSandbox', 'workspace', 'explore', 'answer',
    ],
    requiredFields: [],
    capabilities: {},
  },

  // ---- 编程修复：code_repair（requirements 实际是对象，但 evaluator 当 string[] keywords 读 —— 已知缺陷） ----
  code_repair: {
    grader: 'code_repair',
    version: '3.2.0',
    dimension: 'program',
    consumedFields: ['functionName', 'initialCode', 'hiddenTests', 'explanationKeywords', 'isCorrectCodeTrap'],
    declaredFields: ['functionName', 'initialCode', 'hiddenTests', 'explanationKeywords', 'isCorrectCodeTrap'],
    requiredFields: [],
    capabilities: {
      supportedLanguages: ['javascript', 'typescript', 'python', 'go', 'java', 'c', 'cpp', 'csharp', 'rust', 'php', 'sql', 'bash', 'markdown'],
      executableLanguages: ['javascript', 'typescript', 'python'],
    },
    aliases: ['code_repair_v3'],
  },

  // ---- 缺陷定位：bug_finding（有 evaluator，主题库暂无题） ----
  bug_finding: {
    grader: 'bug_finding',
    version: 'bug_finding_v2',
    dimension: 'program',
    consumedFields: [],
    declaredFields: [],
    requiredFields: [],
    capabilities: {},
  },
};

/** 按 grader 名查契约（含别名；未注册 → undefined） */
export function getGraderContract(grader: string): GraderContract | undefined {
  const direct = GRADER_CONTRACTS[grader];
  if (direct) return direct;
  for (const c of Object.values(GRADER_CONTRACTS)) {
    if (c.aliases?.includes(grader)) return c;
  }
  return undefined;
}

/** 所有已注册 grader 契约 */
export function listGraderContracts(): GraderContract[] {
  return Object.values(GRADER_CONTRACTS);
}
