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
  // v4：verificationMode 十分支（exact_fact/premise_correction/refusal_nonfabrication/
  // temporal_humility/rag_attribution/fictional_citation/identifier_checksum/
  // identifier_format/reference_selection/citation_completeness）+ hardVeto 硬否决 +
  // ISBN/DOI 校验 + RAG 归因 + fabricationAnchors 上下文窗口。
  // aliases 保留 hallucination_v3/v2/v1：v4 评分器兼容旧题（无 verificationMode 走 v3 兼容路径）。
  hallucination_resistance: {
    grader: 'hallucination_resistance',
    version: 'hallucination_v4',
    dimension: 'hallucination_resistance',
    consumedFields: [
      'answerability', 'answerKeywords', 'answer', 'correctionKeywords',
      'citationTrap', 'fabricationAnchors', 'referenceAnswer', 'validUntil',
      // v4 新增消费字段
      'verificationMode', 'attackLevel', 'temporalPolicy', 'materials',
      'expected', 'fictionalEntities', 'judgeNotes',
    ],
    declaredFields: [
      'answerability', 'answerKeywords', 'answer', 'correctionKeywords',
      'citationTrap', 'fabricationAnchors', 'referenceAnswer', 'validUntil',
      'verificationMode', 'attackLevel', 'temporalPolicy', 'materials',
      'expected', 'fictionalEntities', 'judgeNotes',
      // expected 子字段（对象结构，health-check 用于深度校验）
      'expected.answers', 'expected.citations', 'expected.validIdentifiers',
      'expected.invalidIdentifiers', 'expected.allRequired',
    ],
    requiredFields: ['answerability'],
    capabilities: {},
    aliases: ['hallucination_v3', 'hallucination_v2', 'hallucination_v1'],
  },

  // ---- 工具调用 / CLI 工作流：tool_call_trace ----
  tool_call_trace: {
    grader: 'tool_call_trace',
    version: 'tool_trace_v4',
    dimension: 'tool_cli_workflow',
    consumedFields: [
      'tool', 'params', 'commands', 'should_call', 'should_call_first',
      'should_not_call', 'should_not_directly', 'should_not_call_any',
      'minimal_calls', 'require_patterns', 'sequence', 'orderMatters',
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
    version: 'cli_command_v4', // P0-A1-1：真实执行钩子；P1-A3-2：覆盖率感知（去默认 80）
    dimension: 'cli_deep_tasks',
    consumedFields: [
      'requiredCommands', 'requiredFlags', 'pipelineTokens', 'targetKeywords', 'safetyTokens',
      'requiresSandbox', 'workspace', 'endStatePatterns',
    ],
    declaredFields: [
      'requiredCommands', 'requiredFlags', 'pipelineTokens', 'targetKeywords', 'safetyTokens',
      'requiresSandbox', 'workspace', 'endStatePatterns', 'disciplineCapPatterns', 'explore', 'answer',
    ],
    requiredFields: [],
    capabilities: {},
    aliases: ['cli_command_v1', 'cli_command_v2'],
  },

  // ---- 编程修复：code_repair（requirements 实际是对象，但 evaluator 当 string[] keywords 读 —— 已知缺陷） ----
  code_repair: {
    grader: 'code_repair',
    version: '3.2.0',
    dimension: 'program',
    consumedFields: ['functionName', 'initialCode', 'hiddenTests', 'explanationKeywords', 'isCorrectCodeTrap'],
    declaredFields: ['functionName', 'initialCode', 'hiddenTests', 'explanationKeywords', 'isCorrectCodeTrap', 'fixture', 'referenceSolution'],
    requiredFields: [],
    capabilities: {
      supportedLanguages: ['javascript', 'typescript', 'python', 'go', 'java', 'c', 'cpp', 'csharp', 'rust', 'php', 'sql', 'bash', 'markdown'],
      executableLanguages: ['javascript', 'typescript', 'python'],
    },
    aliases: ['code_repair_v3'],
  },

  // ---- 多文件项目修复：project_repair（长任务，多文件工作区 + 容器测试套件） ----
  project_repair: {
    grader: 'project_repair',
    version: '1.0.0',
    dimension: 'program',
    consumedFields: ['files', 'hiddenTestFiles', 'hiddenTests', 'publicTests', 'functionName', 'explanationKeywords', 'image'],
    declaredFields: ['files', 'hiddenTestFiles', 'hiddenTests', 'publicTests', 'functionName', 'explanationKeywords', 'image'],
    requiredFields: ['files'],
    capabilities: {
      supportedLanguages: ['javascript', 'typescript', 'python', 'go', 'java', 'c', 'cpp', 'csharp', 'rust', 'php', 'sql', 'bash'],
      executableLanguages: ['javascript', 'typescript', 'python', 'go', 'java', 'c', 'cpp', 'csharp', 'rust', 'php', 'sql', 'bash'],
    },
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

  // ---- 单条 SQL 沙箱执行：sandbox（CP-L3-SQL-007 wcte 去重） ----
  sandbox: {
    grader: 'sandbox',
    version: '1.0.0',
    dimension: 'program',
    consumedFields: ['prompt', 'category', 'schema', 'scoring'],
    declaredFields: ['prompt', 'category', 'schema', 'scoring', 'hiddenTests'],
    requiredFields: ['prompt'],
    capabilities: {
      supportedLanguages: ['sql', 'postgresql'],
      executableLanguages: ['sql', 'postgresql'],
    },
  },

  // ---- PR 评审质量：llm_judge（PR-ELITE-012/013） ----
  llm_judge: {
    grader: 'llm_judge',
    version: '1.0.0',
    dimension: 'program',
    consumedFields: ['diff', 'prompt', 'judge_config', 'judge_ground_truth', 'scoring'],
    declaredFields: ['diff', 'prompt', 'judge_config', 'judge_ground_truth', 'scoring'],
    requiredFields: ['diff', 'judge_ground_truth'],
    capabilities: {
      supportedLanguages: ['pr_review'],
      executableLanguages: [],
    },
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

// ============================================================
// 维度非重叠定义（A1-2）：明确三个「工具/CLI/工作流」维度各自只测什么，
// 避免题库作者混淆、或同一能力被重复计量。每个维度有独立的 signature 字段集合。
// ============================================================
export const DIMENSION_DEFINITIONS: Record<string, { summary: string; signatureFields: string[] }> = {
  tool_cli_workflow: {
    summary: 'API/函数工具调用：模型是否以结构化形态调用了正确的工具、参数正确、顺序正确',
    signatureFields: [
      'tool', 'params', 'commands', 'should_call', 'should_call_first', 'should_not_call',
      'should_not_directly', 'should_not_call_any', 'minimal_calls', 'require_patterns', 'sequence', 'orderMatters',
    ],
  },
  cli_deep_tasks: {
    summary: 'Shell/CLI 脚本能力：模型是否产出正确可执行的命令行/管道，真实产生正确的端状态',
    signatureFields: [
      'requiredCommands', 'requiredFlags', 'pipelineTokens', 'targetKeywords', 'safetyTokens',
      'requiresSandbox', 'workspace', 'endStatePatterns',
    ],
  },
  agent_workflow: {
    summary: '多步智能体规划：模型是否展现出规划、按序执行动作、发生状态变化、达成完成态',
    signatureFields: [
      'expectedActions', 'expectedStateChanges', 'completionKeywords', 'planningKeywords',
      'forbiddenActions', 'safetyCapActions', 'stateFixture', 'responseMode',
    ],
  },
};

/** 根据 requirements 字段推荐归属维度（A1-2 防重叠）。无命中返回 null。 */
export function recommendDimension(requirements: Record<string, unknown>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [dim, def] of Object.entries(DIMENSION_DEFINITIONS)) {
    const count = def.signatureFields.filter((f) => (requirements as Record<string, unknown>)[f] != null).length;
    if (count > bestCount) {
      best = dim;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : null;
}

/**
 * 校验题集维度互斥（A1-2）：若某题 requirements 同时命中多个维度的 signature 字段，
 * 说明该题考察点与其他维度重叠，可能重复计量。返回告警列表（空数组=通过）。
 */
export function validateDimensionDisjointness(
  dimension: string,
  requirements: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  const otherSigs = Object.entries(DIMENSION_DEFINITIONS)
    .filter(([d]) => d !== dimension)
    .flatMap(([, def]) => def.signatureFields);
  const collisions = [...new Set(otherSigs.filter((f) => (requirements as Record<string, unknown>)[f] != null))];
  if (collisions.length > 0) {
    warnings.push(
      `dimension "${dimension}" requirements also contain fields from other dimensions: ${collisions.join(', ')}`,
    );
  }
  const rec = recommendDimension(requirements);
  if (rec && rec !== dimension) {
    warnings.push(`requirements signature suggests dimension "${rec}" but scenario is labeled "${dimension}"`);
  }
  return warnings;
}

/** 所有已注册 grader 契约 */
export function listGraderContracts(): GraderContract[] {
  return Object.values(GRADER_CONTRACTS);
}
