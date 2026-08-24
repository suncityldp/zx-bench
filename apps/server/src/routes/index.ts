// ============================================================
// API 路由注册
// ============================================================

import type { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import type { APIResponse, ModelConfig, EvalRunConfig, CreateEvalRunRequest, CreateBatchEvalRunRequest, CreateBatchEvalRunResponse, BatchProgressResponse, BatchRunStatus, BatchRunInfo, ScenarioTier, EvalProgress, DimensionProgress, QuestionLiveResult, EvalStage, OutputPolicy } from '@zxbench/types';
import { generateId, generateRunId } from '@zxbench/utils';
import { orchestrateEvaluation, generateManifest, callModel } from '@zxbench/core';
import { generateReport, generateCompareReport } from '@zxbench/core';
import type { ReportUserPromptData, CompareReportUserPromptData } from '@zxbench/core';
import { computeWeightedTotal, computeDifficultyWeightedDimAvgs as computeDifficultyWeightedDimAvgsPure, validateScenario } from '@zxbench/core';
import { broadcastProgress, getLatestProgress } from '../ws/index.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { URL } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Pack 短名 → 维度映射（all 表示不过滤） */
const PACK_DIMENSION_MAP: Record<string, string> = {
  de: 'data_extraction',
  if: 'instruction_following',
  rm: 'reasoning_math',
  so: 'structured_output',
  tc: 'tool_cli_workflow',
  sa: 'safety_authority',
  aw: 'agent_workflow',
  cli: 'cli_deep_tasks',
  pr: 'program',
  all: '',
};

/** 维度短名 → 中文标签 */
function dimensionLabel(dim: string): string {
  const map: Record<string, string> = {
    data_extraction: '数据抽取',
    instruction_following: '指令遵循',
    reasoning_math: '推理数学',
    structured_output: '结构化输出',
    tool_cli_workflow: '工具CLI',
    safety_authority: '安全权限',
    agent_workflow: '智能体工作流',
    cli_deep_tasks: '深度CLI任务',
    program: '编程能力',
    hallucination_resistance: '幻觉抵抗',
  };
  return map[dim] || dim;
}

/** 维度短名 → 英文标签 */
const DIMENSION_LABELS_EN: Record<string, string> = {
  data_extraction: 'Data Extraction',
  instruction_following: 'Instruction Following',
  reasoning_math: 'Reasoning & Math',
  structured_output: 'Structured Output',
  tool_cli_workflow: 'Tool/CLI Workflow',
  safety_authority: 'Safety & Authority',
  agent_workflow: 'Agent Workflow',
  cli_deep_tasks: 'Deep CLI Tasks',
  program: 'Programming',
  hallucination_resistance: 'Hallucination Resistance',
};

/** 按语言返回维度标签 */
function dimensionLabelFor(dim: string, lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en' ? (DIMENSION_LABELS_EN[dim] || dim) : dimensionLabel(dim);
}

/**
 * 计算难度加权维度均分（DB wrapper）：批量获取题目难度 → 调用纯函数 computeDifficultyWeightedDimAvgsPure
 * 维度均分 = Σ(题目得分 × 难度权重) / Σ(难度权重)；难度越高权重越大（easy=1…adversarial=2.5）
 */
async function computeDifficultyWeightedDimAvgs(
  results: Array<{ scenarioId: string; dimension: string; totalScore: number; environmentError?: boolean }>,
): Promise<Map<string, number>> {
  if (results.length === 0) return new Map();
  const scenarioIds = [...new Set(results.map((r) => r.scenarioId))];
  const scenarios = await prisma.scenarioDefinition.findMany({
    where: { id: { in: scenarioIds } },
    select: { id: true, difficulty: true, requirements: true },
  });
  const difficultyLookup = new Map<string, string>();
  for (const s of scenarios) {
    difficultyLookup.set(s.id, s.difficulty);
  }
  // 沙箱执行已实现（工作区物化 + 探查转录）：requiresSandbox 调查题结果可参与维度均分
  return computeDifficultyWeightedDimAvgsPure(results, difficultyLookup);
}

/**
 * 计算某模型聚合结果对应的「基准题库总量」。
 * 用于报告/排行榜的 totalScenarios：以题库真实题量为准（全量=404，或所选维度并集的题量），
 * 而不是以「实际已有结果行」的数量为准，避免 run 中途被打断丢题后总数被低估。
 * @param dimensionFilters 参与聚合的各 run 的 dimensionFilter（全量 run 为 null/空数组）
 */
async function getBenchmarkScopeTotal(
  dimensionFilters: (string[] | null | undefined)[],
): Promise<number> {
  const union = new Set<string>();
  let anyFull = false;
  for (const f of dimensionFilters) {
    if (!f || f.length === 0) { anyFull = true; break; }
    for (const d of f) union.add(d);
  }
  if (anyFull || union.size === 0) {
    return await prisma.scenarioDefinition.count();
  }
  return await prisma.scenarioDefinition.count({ where: { dimension: { in: [...union] } } });
}

/** 解析 run.dimensionFilter 字符串为数组（容错） */
function parseDimensionFilter(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 递归查找 zxbench.pack.json（限深度 3） */
function findPackJson(dir: string, depth = 0): string | null {
  if (depth > 3) return null;
  const candidate = path.join(dir, 'zxbench.pack.json');
  if (fs.existsSync(candidate)) return candidate;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findPackJson(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ===== GPT5.6 P0-4: API Key 加密存储 =====

/** 加密密钥（从环境变量或固定默认值） */
const ENCRYPTION_KEY = process.env.ZXBENCH_ENCRYPTION_KEY || 'zxbench-default-key-change-me!';
const ENCRYPTION_ALGO = 'aes-256-cbc';

function getEncryptionKey(): Buffer {
  return scryptSync(ENCRYPTION_KEY, 'zxbench-salt', 32);
}

function encryptApiKey(plainText: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptApiKey(encrypted: string): string {
  const key = getEncryptionKey();
  const [ivHex, data] = encrypted.split(':');
  if (!ivHex || !data) return encrypted; // 未加密的旧数据直接返回
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv(ENCRYPTION_ALGO, key, iv);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/** 脱敏 API Key：仅显示最后 4 位 */
function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 4) return '****';
  return '*'.repeat(key.length - 4) + key.slice(-4);
}

/** 默认评测配置 */
const DEFAULT_EVAL_CONFIG: EvalRunConfig = {
  maxTokens: 8192,
  temperature: null,
  runsPerQuestion: 5, // GPT5.6 P1-2: 日常回归默认 5，模型比较 10
  judgeEnabled: false,
  escalationEnabled: false,
  escalationThreshold: 0.85,
  safetyCheckEnabled: true,
  hiddenTestsEnabled: true,
  structuredOutputEnabled: false,
  parallelism: 4, // 默认并发 4 个题目（全局题目池模式）
};

// ===== 评测运行控制器（暂停/继续/取消）=====

interface EvalRunController {
  state: 'running' | 'paused' | 'cancelled';
  resumePromise: Promise<void> | null;
  resumeResolve: (() => void) | null;
  restartRequested?: boolean;
  completionPromise: Promise<void> | null;
  completionResolve: (() => void) | null;
  /** 运行中的最新配置引用（实时监控修改 maxTokens 后，后续题目立即生效） */
  config?: EvalRunConfig;
}

/** 所有活跃评测的控制器映射 */
const evalControllers = new Map<string, EvalRunController>();
const serverStartTime = new Date();

/**
 * 运行中的实时进度状态（worker 与单题重试共享）。
 * 单题重试成功后直接就地修正 recentResults / dimMap，避免 worker 下一次广播用旧状态覆盖重试结果，
 * 导致实时监控里「重试成功」的题目一会又显示为失败。
 */
interface RunLiveState {
  recentResults: QuestionLiveResult[];
  dimMap: Map<string, { total: number; completed: number; passed: number; failed: number; redLine: number; scores: number[] }>;
}
const runLiveStates = new Map<string, RunLiveState>();

/** 暂停指定评测 */
function pauseEvaluation(runId: string): boolean {
  const ctrl = evalControllers.get(runId);
  if (!ctrl || ctrl.state !== 'running') return false;
  ctrl.state = 'paused';
  return true;
}

/**
 * 硬性配额/鉴权错误检测（兜底）：这些错误重试或继续跑都无意义，
 * 应立即暂停评测，避免把剩余题目全部打成 0 分浪费 token。
 * 用户充值/修复后 resume 即可从断点续跑，未生成的题目不会被烧掉。
 */
function isHardQuotaError(msg: string): boolean {
  return /余额不足|资源包|无可用|insufficient|out of (?:quota|balance)|(?:quota|balance) exceeded|1113|unauthorized|forbidden|invalid api|authentication/i.test(msg)
    || /\b(401|403)\b/.test(msg);
}

/** 继续指定评测 */
function resumeEvaluation(runId: string): boolean {
  const ctrl = evalControllers.get(runId);
  if (!ctrl || ctrl.state !== 'paused') return false;
  ctrl.state = 'running';
  if (ctrl.resumeResolve) {
    ctrl.resumeResolve();
    ctrl.resumeResolve = null;
    ctrl.resumePromise = null;
  }
  return true;
}

/** 取消指定评测 */
function cancelEvaluation(runId: string): boolean {
  const ctrl = evalControllers.get(runId);
  if (!ctrl) return false;
  ctrl.state = 'cancelled';
  if (ctrl.resumeResolve) {
    ctrl.resumeResolve();
    ctrl.resumeResolve = null;
    ctrl.resumePromise = null;
  }
  return true;
}

/** 检查并等待暂停状态（每题之间调用） */
async function checkPause(runId: string): Promise<'continue' | 'cancelled'> {
  const ctrl = evalControllers.get(runId);
  if (!ctrl) return 'continue';
  // Note: state can change asynchronously during await, so we re-read it
  const stateBefore = ctrl.state as string;
  if (stateBefore === 'cancelled') return 'cancelled';
  if (stateBefore === 'paused') {
    // 等待 resume 信号
    ctrl.resumePromise = new Promise<void>((resolve) => {
      ctrl.resumeResolve = resolve;
    });
    await ctrl.resumePromise;
    ctrl.resumePromise = null;
    ctrl.resumeResolve = null;
  }
  // Re-read state after potentially being resumed
  return ctrl.state === 'cancelled' ? 'cancelled' : 'continue';
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ===== 健康检查 =====
  app.get('/api/health', async () => {
    return { status: 'ok', version: '0.2.0', buildTime: process.env.BUILD_TIME || 'dev' };
  });

  // ===== 版本信息（部署验证用） =====
  app.get('/api/version', async () => {
    const now = new Date().toISOString();
    return {
      version: '0.2.0',
      buildTime: process.env.BUILD_TIME || 'dev',
      serverStartTime: serverStartTime,
      uptimeSeconds: serverStartTime ? Math.round((Date.now() - serverStartTime.getTime()) / 1000) : 0,
      nodeVersion: process.version,
      features: {
        reasoningModelSupport: true,
        multiLevelRetry: true,      // orchestrator: 8192→16384→32768→65536
        judgeJsonRepair: true,
        qualityReport: true,         // 跑后自动诊断
        aiReportGeneration: true,    // AI 评测分析报告生成
        modelCompareReport: true,    // 模型对比报告生成
      },
    };
  });

  // ===== 模型配置 =====
  /** 连通性测试：用小请求验证模型端点可用（模型 ID/密钥/网络任一出错即失败） */
  async function testModelConnectivity(cfg: { name: string; provider: string; baseUrl: string; apiKey?: string; reasoningModel?: boolean }): Promise<{ ok: boolean; latencyMs?: number; error?: string; requiresTemperatureOne?: boolean }> {
    const start = Date.now();
    const baseConfig = {
      id: 'connectivity-test',
      name: cfg.name,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      defaultParams: {},
      reasoningModel: cfg.reasoningModel === true,
    };
    // 温度候选：推理模型（Kimi K3/DeepSeek-R1 等只接受 temperature=1）优先 1，普通模型优先 0。
    // 若返回 temperature 不合法（如 "only 1 is allowed"），自动换另一个温度重试。
    const temperatureCandidates = cfg.reasoningModel ? [1, 0] : [0, 1];
    let lastError = '';
    let requiresTemperatureOne = false;
    for (const temperature of temperatureCandidates) {
      try {
        const resp = await callModel({
          config: baseConfig,
          params: { maxTokens: 16, temperature },
          userPrompt: '请回复: OK',
        });
        if (!resp.content && !resp.reasoningContent) {
          return { ok: false, error: '端点返回了空响应，请检查模型 ID 是否正确' };
        }
        return { ok: true, latencyMs: Date.now() - start, requiresTemperatureOne };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        // 仅当是 temperature 相关错误时才换候选重试；其它错误（404/401/网络等）直接跳出
        if (!/temperature/i.test(msg)) break;
        // 拒绝了 temperature=0 且用 1 重试成功 → 该模型强制 temperature=1（如 Kimi K3）
        if (temperature === 0) requiresTemperatureOne = true;
      }
    }
    const msg = lastError;
    // 常见错误给出可读提示
    if (msg.includes('404')) {
      return { ok: false, error: `连接失败：模型 ID “${cfg.name}” 在该端点不存在（404）。请核对平台文档中的真实模型 ID（通常是小写连字符格式，如 qwen3.8-max，而非显示名称）。原始错误: ${msg.slice(0, 200)}` };
    }
    if (msg.includes('401') || msg.includes('403')) {
      return { ok: false, error: `连接失败：API Key 无效或无权限（${msg.slice(0, 120)}）` };
    }
    return { ok: false, error: `连接失败: ${msg.slice(0, 300)}` };
  }

  /** 独立的连通性测试接口（前端可预检，不落库） */
  app.post('/api/models/test', async (request) => {
    const body = request.body as { name?: string; provider?: string; baseUrl?: string; apiKey?: string; reasoningModel?: boolean };
    if (!body.name || !body.baseUrl) {
      return { success: false, error: '模型名称和 Base URL 为必填项' };
    }
    const result = await testModelConnectivity({ name: body.name, provider: body.provider || 'openai', baseUrl: body.baseUrl, apiKey: body.apiKey, reasoningModel: body.reasoningModel });
    return result.ok
      ? { success: true, data: { latencyMs: result.latencyMs } }
      : { success: false, error: result.error };
  });

  app.get('/api/models', async () => {
    try {
      const models = await prisma.modelConfig.findMany();
      return { success: true, data: models.map(deserializeModelMasked) };
    } catch (err) {
      return { success: false, error: `获取模型列表失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  app.post('/api/models', async (request, reply) => {
    try {
      const body = request.body as Partial<ModelConfig> & { modelType?: string; reasoningModel?: boolean };
      if (!body.name || !body.baseUrl) {
        return reply.status(400).send({ success: false, error: '模型名称和 Base URL 为必填项' });
      }
      // AI Judge 强制连通性预检：测试不通过拒绝落库，防止整批评测因 Judge 配置错误作废
      let requiresTemperatureOne = false;
      if (body.modelType === 'judge') {
        const test = await testModelConnectivity({
          name: body.name,
          provider: body.provider || 'openai',
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          reasoningModel: body.reasoningModel,
        });
        if (!test.ok) {
          console.warn(`[ModelConfig] AI Judge 添加被拒绝（连通性测试失败）: ${body.name} @ ${body.baseUrl} — ${test.error}`);
          return reply.status(400).send({ success: false, error: test.error });
        }
        requiresTemperatureOne = test.requiresTemperatureOne === true;
        if (requiresTemperatureOne && !body.reasoningModel) {
          console.warn(`[ModelConfig] ${body.name} 仅接受 temperature=1，已自动标记为推理模型`);
        }
        console.log(`[ModelConfig] AI Judge 连通性测试通过: ${body.name} @ ${body.baseUrl} (${test.latencyMs}ms)`);
      }
      const model = await prisma.modelConfig.create({
        data: {
          name: body.name,
          displayName: body.displayName || null, // 模型名称（显示名），null 时前端显示 name（模型 ID）
          provider: body.provider || 'openai',
          baseUrl: body.baseUrl,
          apiKey: body.apiKey ? encryptApiKey(body.apiKey) : null,
          defaultParams: JSON.stringify(body.defaultParams || {}),
          modelType: body.modelType === 'judge' ? 'judge' : 'tested',
          reasoningModel: body.reasoningModel === true || requiresTemperatureOne,
        },
      });
      return { success: true, data: deserializeModelMasked(model) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, error: `添加模型失败: ${msg}` });
    }
  });

  app.delete('/api/models/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      await prisma.modelConfig.delete({ where: { id } });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `删除失败: ${msg}` };
    }
  });

  // 编辑模型（主要修改模型名称 displayName，也可修改 name/baseUrl/apiKey/reasoningModel）
  app.patch('/api/models/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as Partial<ModelConfig> & { modelType?: string; reasoningModel?: boolean };
      const existing = await prisma.modelConfig.findUnique({ where: { id } });
      if (!existing) {
        return reply.status(404).send({ success: false, error: '模型不存在' });
      }
      // 只更新传入的字段
      const data: {
        name?: string; displayName?: string | null; provider?: string;
        baseUrl?: string; apiKey?: string | null; reasoningModel?: boolean;
      } = {};
      if (body.displayName !== undefined) data.displayName = body.displayName || null;
      if (body.name !== undefined && body.name) data.name = body.name;
      if (body.provider !== undefined) data.provider = body.provider;
      if (body.baseUrl !== undefined && body.baseUrl) data.baseUrl = body.baseUrl;
      if (body.apiKey !== undefined) data.apiKey = body.apiKey ? encryptApiKey(body.apiKey) : null;
      if (body.reasoningModel !== undefined) data.reasoningModel = body.reasoningModel;
      if (Object.keys(data).length === 0) {
        return reply.status(400).send({ success: false, error: '没有可更新的字段' });
      }
      const model = await prisma.modelConfig.update({ where: { id }, data });
      return { success: true, data: deserializeModelMasked(model) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, error: `更新模型失败: ${msg}` });
    }
  });

  // ===== 评测运行 =====
  app.get('/api/runs', async () => {
    const runs = await prisma.evalRun.findMany({
      orderBy: { createdAt: 'desc' },
      include: { modelConfig: true },
    });
    return {
      success: true,
      data: runs.map((run) => ({
        ...run,
        config: JSON.parse(run.config),
        manifest: run.manifest ? JSON.parse(run.manifest) : null,
        summary: run.summary ? JSON.parse(run.summary) : null,
        modelConfig: deserializeModel(run.modelConfig),
        _count: undefined,
      })),
    };
  });

  app.get('/api/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const run = await prisma.evalRun.findUnique({
      where: { id },
      include: {
        modelConfig: true,
        results: { orderBy: { startedAt: 'asc' } },
      },
    });
    if (!run) return { success: false, error: 'Run not found' };
    return {
      success: true,
      data: {
        ...run,
        config: JSON.parse(run.config),
        manifest: run.manifest ? JSON.parse(run.manifest) : null,
        summary: run.summary ? JSON.parse(run.summary) : null,
        modelConfig: deserializeModel(run.modelConfig),
        results: run.results.map(deserializeResult),
      },
    };
  });

  /** 实时修改运行配置（生成额度 maxTokens 等）。运行中：后续题目立即生效；已完成：保存供重算/重跑 */
  app.patch('/api/runs/:id/config', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { maxTokens?: number };
    const run = await prisma.evalRun.findUnique({ where: { id } });
    if (!run) return reply.status(404).send({ success: false, error: '评测不存在' });

    const config = JSON.parse(run.config) as Record<string, unknown>;
    if (typeof body.maxTokens !== 'number' || body.maxTokens < 256) {
      return reply.status(400).send({ success: false, error: 'maxTokens 必须是不小于 256 的数字' });
    }
    const prev = config.maxTokens;
    config.maxTokens = body.maxTokens;
    await prisma.evalRun.update({ where: { id }, data: { config: JSON.stringify(config) } });

    // 运行中：更新控制器持有的配置引用，后续题目立即生效（无需重启）
    const ctrl = evalControllers.get(id);
    if (ctrl && ctrl.config) {
      ctrl.config.maxTokens = body.maxTokens;
    }

    const isActive = run.status === 'running' || run.status === 'pending' || run.status === 'paused';
    return {
      success: true,
      data: {
        maxTokens: config.maxTokens,
        notice: isActive
          ? `已更新（${prev} → ${body.maxTokens}），后续题目立即生效；已完成的题目不受影响。`
          : `已保存（${prev} → ${body.maxTokens}），该评测已结束，将在重算/重跑时生效。`,
      },
    };
  });

  /** 组结果聚合 — 返回同组所有运行的去重结果（按scenarioId取最高分） */
  app.get('/api/runs/:id/group-results', async (request) => {
    const { id } = request.params as { id: string };
    const run = await prisma.evalRun.findUnique({ where: { id }, include: { modelConfig: true } });
    if (!run) return { success: false, error: 'Run not found' };

    // 获取同组所有运行ID
    const groupName = run.groupName;
    const siblingRuns = groupName
      ? await prisma.evalRun.findMany({ where: { groupName }, select: { id: true, status: true } })
      : [{ id: run.id, status: run.status }];
    const runIds = siblingRuns.map((r) => r.id);

    // 查询所有结果，按 scenarioId 去重取最高分
    const allResults = await prisma.scenarioResult.findMany({
      where: { evalRunId: { in: runIds } },
      orderBy: { startedAt: 'asc' },
    });

    const dedup = new Map<string, typeof allResults[number]>();
    const isEnvError = (r: { environmentError?: boolean | null }) => r.environmentError === true;
    for (const r of allResults) {
      const existing = dedup.get(r.scenarioId);
      // 优先非环境故障行（重试成功覆盖环境故障；同状态取高分）
      if (!existing
        || (isEnvError(existing) && !isEnvError(r))
        || (!isEnvError(existing) && !isEnvError(r) && r.totalScore > existing.totalScore)) {
        dedup.set(r.scenarioId, r);
      }
    }
    const results = Array.from(dedup.values());

    // 反序列化
    const deserialized = results.map((r) => ({
      ...r,
      outputMetadata: JSON.parse(r.outputMetadata),
      axisScores: JSON.parse(r.axisScores),
      scoreHistory: JSON.parse(r.scoreHistory),
      verdictHistory: JSON.parse(r.verdictHistory),
      evidence: JSON.parse(r.evidence),
      localJudge: r.localJudge ? JSON.parse(r.localJudge) : null,
      frontierJudge: r.frontierJudge ? JSON.parse(r.frontierJudge) : null,
      finalJudge: r.finalJudge ? JSON.parse(r.finalJudge) : null,
    }));

    // 计算评测起止时间（跨所有子运行）
    let evalStartedAt: Date | null = null;
    let evalFinishedAt: Date | null = null;
    for (const r of allResults) {
      if (!evalStartedAt || r.startedAt < evalStartedAt) evalStartedAt = r.startedAt;
      if (!evalFinishedAt || r.finishedAt > evalFinishedAt) evalFinishedAt = r.finishedAt;
    }

    return {
      success: true,
      data: {
        runId: run.id,
        runName: run.name,
        status: run.status,
        groupName,
        totalRuns: siblingRuns.length,
        totalResults: deserialized.length,
        modelConfig: deserializeModel(run.modelConfig),
        config: JSON.parse(run.config),
        summary: run.summary ? JSON.parse(run.summary) : null,
        results: deserialized,
        evalStartedAt,
        evalFinishedAt,
      },
    };
  });

  // 创建并启动评测运行
  app.post('/api/runs', async (request, reply) => {
    try {
      const body = request.body as CreateEvalRunRequest;
      const modelConfig = await prisma.modelConfig.findUnique({ where: { id: body.modelConfigId } });
      if (!modelConfig) {
        return reply.status(400).send({ success: false, error: '被测模型配置不存在' });
      }

      const runId = generateRunId();
      const config = { ...DEFAULT_EVAL_CONFIG, ...body.config };

      // 拉齐评测配置：推理模型强制 maxTokens 下限
      // （防止同一排行榜下不同模型评测条件不一致导致排名失真，如 27B 推理模型被 8192 预算系统性压低）
      let configNotice: string | null = null;
      if (modelConfig.reasoningModel && (!config.maxTokens || config.maxTokens < 32768)) {
        config.maxTokens = 49152;
        configNotice = `推理模型 ${modelConfig.name} 的 maxTokens 低于 32768，已自动提升至 49152（拉齐评测配置，避免思考链截断压低分数）`;
      }

      // 构建 Judge 配置（在落库前解析，把实际生效的 Judge ID 固化进 config，便于审计与重跑还原）
      let judgeOptions: import('@zxbench/core').JudgeOptions | undefined;
      if (config.judgeEnabled) {
        // 优先使用前端传入的 judgeModelConfigId，否则查找第一个 judge 类型的模型
        let judgeRow = body.judgeModelConfigId
          ? await prisma.modelConfig.findUnique({ where: { id: body.judgeModelConfigId } })
          : await prisma.modelConfig.findFirst({ where: { modelType: 'judge' } });
        if (judgeRow) {
          config.judgeModelConfigId = judgeRow.id;
          console.log(`[Eval] Judge 模型已选定: ${judgeRow.name} (${judgeRow.id})${body.judgeModelConfigId ? '' : ' ← findFirst 自动选择，建议前端显式指定'}`);
          judgeOptions = {
            localModel: {
              id: judgeRow.id,
              name: judgeRow.name,
              provider: judgeRow.provider,
              baseUrl: judgeRow.baseUrl,
              apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
              defaultParams: JSON.parse(judgeRow.defaultParams),
              reasoningModel: judgeRow.reasoningModel,
            },
            escalationThreshold: config.escalationThreshold || 0.85,
          };
        } else {
          console.warn('judgeEnabled=true 但未配置 Judge 模型，跳过 AI Judge');
        }
      }

      const run = await prisma.evalRun.create({
        data: {
          id: runId,
          name: body.name || `Eval ${new Date().toLocaleString()}`,
          modelConfigId: body.modelConfigId,
          config: JSON.stringify(config),
          status: 'pending',
          parentRunId: body.parentRunId || null,
          groupName: body.groupName || null,
          dimensionFilter: body.dimensionIds?.length > 0 ? JSON.stringify(body.dimensionIds) : null,
        },
      });

      reply.send({ success: true, data: { id: run.id, status: run.status, configNotice } });

      // 注册控制器（带 completion promise）
      const ctrl0: EvalRunController = { state: 'running', resumePromise: null, resumeResolve: null, completionPromise: null, completionResolve: null };
      ctrl0.completionPromise = new Promise<void>((resolve) => { ctrl0.completionResolve = resolve; });
      evalControllers.set(run.id, ctrl0);

      // 后台执行评测
      runEvaluation(run.id, modelConfig, config, judgeOptions).catch((err) => {
        console.error('Evaluation failed:', err);
        prisma.evalRun.update({
          where: { id: run.id },
          data: { status: 'failed' },
        }).catch(console.error);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, error: `创建评测失败: ${msg}` });
    }
  });

  // ===== 多模型并行评测：一次请求并发启动多个不同模型的评测任务 =====
  /** 解析 AI Judge 配置（批量场景共享一个 Judge 模型；实际生效 ID 固化进 config） */
  async function resolveJudgeOptionsForBatch(config: EvalRunConfig, judgeModelConfigId?: string): Promise<import('@zxbench/core').JudgeOptions | undefined> {
    if (!config.judgeEnabled) return undefined;
    const judgeRow = judgeModelConfigId
      ? await prisma.modelConfig.findUnique({ where: { id: judgeModelConfigId } })
      : await prisma.modelConfig.findFirst({ where: { modelType: 'judge' } });
    if (!judgeRow) {
      console.warn('[Batch] judgeEnabled=true 但未配置 Judge 模型，跳过 AI Judge');
      return undefined;
    }
    config.judgeModelConfigId = judgeRow.id;
    console.log(`[Batch] Judge 模型已选定: ${judgeRow.name} (${judgeRow.id})${judgeModelConfigId ? '' : ' ← findFirst 自动选择，建议前端显式指定'}`);
    return {
      localModel: {
        id: judgeRow.id,
        name: judgeRow.name,
        provider: judgeRow.provider,
        baseUrl: judgeRow.baseUrl,
        apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
        defaultParams: JSON.parse(judgeRow.defaultParams),
        reasoningModel: judgeRow.reasoningModel,
      },
      escalationThreshold: config.escalationThreshold || 0.85,
    };
  }

  app.post('/api/runs/batch', async (request, reply) => {
    try {
      const body = request.body as CreateBatchEvalRunRequest;
      const modelConfigIds = Array.isArray(body.modelConfigIds) ? body.modelConfigIds : [];
      if (modelConfigIds.length === 0) {
        return reply.status(400).send({ success: false, error: '请至少选择一个被测模型' });
      }
      const MAX_MODELS = 8;
      if (modelConfigIds.length > MAX_MODELS) {
        return reply.status(400).send({ success: false, error: `单次最多并发 ${MAX_MODELS} 个模型（当前 ${modelConfigIds.length} 个）` });
      }

      const groupName = body.groupName || `batch-${Date.now()}`;
      const config = { ...DEFAULT_EVAL_CONFIG, ...body.config } as EvalRunConfig;
      const judgeOptions = await resolveJudgeOptionsForBatch(config, body.judgeModelConfigId);

      // 预校验所有模型配置（缺失的加入 skipped，不阻断其他模型启动）
      const modelRows = await prisma.modelConfig.findMany({ where: { id: { in: modelConfigIds } } });
      const rowById = new Map(modelRows.map((m) => [m.id, m]));

      const runs: BatchRunInfo[] = [];
      const skipped: Array<{ modelConfigId: string; reason: string }> = [];
      const pendingLaunch: Array<{
        runId: string;
        modelConfigRow: { id: string; name: string; provider: string; baseUrl: string; apiKey: string | null; defaultParams: string };
        cfg: EvalRunConfig;
        judgeOptions?: import('@zxbench/core').JudgeOptions;
      }> = [];

      for (const mcId of modelConfigIds) {
        const mc = rowById.get(mcId);
        if (!mc) {
          skipped.push({ modelConfigId: mcId, reason: '模型配置不存在' });
          continue;
        }
        // 逐模型拉齐评测配置：推理模型强制 maxTokens 下限（避免不同模型评测条件不一致）
        const modelCfg = { ...config } as EvalRunConfig;
        if (mc.reasoningModel && typeof modelCfg.maxTokens === 'number' && modelCfg.maxTokens < 32768) {
          modelCfg.maxTokens = 49152;
        }
        const runId = generateRunId();
        const runName = `${body.name ? body.name + ' · ' : ''}${mc.name}`;
        await prisma.evalRun.create({
          data: {
            id: runId,
            name: runName,
            modelConfigId: mcId,
            config: JSON.stringify(modelCfg),
            status: 'pending',
            parentRunId: null,
            groupName,
            dimensionFilter: body.dimensionIds?.length > 0 ? JSON.stringify(body.dimensionIds) : null,
          },
        });
        runs.push({ id: runId, modelConfigId: mcId, name: runName, status: 'pending' });
        pendingLaunch.push({ runId, modelConfigRow: mc, cfg: modelCfg, judgeOptions });
      }

      if (runs.length === 0) {
        return reply.status(400).send({
          success: false,
          error: '没有可启动的模型（所选模型均不存在）',
          data: { groupName, runs, skipped } as CreateBatchEvalRunResponse,
        });
      }

      // 立即返回批量任务信息，随后并发启动（不串行 await，保证各模型并行而非排队）
      const resp: CreateBatchEvalRunResponse = { groupName, runs, skipped };
      reply.send({ success: true, data: resp });

      // ===== 并发启动：每个模型独立的 runEvaluation，错误相互隔离 =====
      for (const item of pendingLaunch) {
        const ctrl: EvalRunController = { state: 'running', resumePromise: null, resumeResolve: null, completionPromise: null, completionResolve: null };
        ctrl.completionPromise = new Promise<void>((resolve) => { ctrl.completionResolve = resolve; });
        evalControllers.set(item.runId, ctrl);
        runEvaluation(item.runId, item.modelConfigRow, item.cfg, item.judgeOptions).catch((err) => {
          console.error(`[Batch] 模型 ${item.modelConfigRow.name} 评测失败:`, err);
          prisma.evalRun.update({ where: { id: item.runId }, data: { status: 'failed' } }).catch(console.error);
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, error: `批量创建评测失败: ${msg}` });
    }
  });

  // 取消评测
  app.post('/api/runs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    cancelEvaluation(id);
    await prisma.evalRun.update({ where: { id }, data: { status: 'cancelled' } });
    // 广播取消状态（保留进度数据）
    const cached = getLatestProgress(id);
    if (cached) {
      broadcastProgress({ ...cached, status: 'cancelled', current: undefined });
    }
    return { success: true };
  });

  // 暂停评测
  app.post('/api/runs/:id/pause', async (request) => {
    const { id } = request.params as { id: string };
    // 先检查当前状态，已完成/已取消的运行不允许暂停
    const run = await prisma.evalRun.findUnique({ where: { id }, select: { status: true } });
    if (!run) return { success: false, error: 'Run not found' };
    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') {
      return { success: false, error: `Run is already ${run.status}` };
    }
    pauseEvaluation(id);
    await prisma.evalRun.update({ where: { id }, data: { status: 'paused' } });
    // 广播暂停状态（保留进度数据，不清空）
    const cached = getLatestProgress(id);
    if (cached) {
      broadcastProgress({ ...cached, status: 'paused', activeDimensions: [], current: undefined });
    }
    // 如果没有缓存数据，不广播空数据（前端会通过 REST API 获取）
    return { success: true };
  });

  // 继续评测（从中断处恢复）
  app.post('/api/runs/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };

    // 先检查是否是暂停状态（内存中有 controller）
    const ctrl = evalControllers.get(id);
    if (ctrl && ctrl.state === 'paused') {
      // ===== 对账保护：外部删除/修改结果后，内存进度可能虚高 =====
      // 恢复前用数据库「去重完成数」与内存缓存进度对账，不一致则走 runEvaluation 重新对账
      const dbDistinct = await prisma.scenarioResult.findMany({
        where: { evalRunId: id },
        select: { scenarioId: true },
        distinct: ['scenarioId'],
      });
      const cached = getLatestProgress(id);
      const memCompleted = cached?.completed ?? 0;

      if (dbDistinct.length === memCompleted) {
        // 一致：正常内存恢复
        resumeEvaluation(id);
        await prisma.evalRun.update({ where: { id }, data: { status: 'running' } });
        // 广播恢复状态（保留进度数据）
        if (cached) {
          broadcastProgress({ ...cached, status: 'running', currentStage: 'initializing' });
        }
        return { success: true };
      }

      // 不一致：停掉旧 worker、标记 failed，落到下方异常中断恢复（runEvaluation 重新对账）
      console.warn(`[Resume] 进度对账不一致（DB=${dbDistinct.length} vs 内存=${memCompleted}），改用 runEvaluation 重新对账`);
      cancelEvaluation(id);
      await prisma.evalRun.update({ where: { id }, data: { status: 'failed' } });
    }

    // 防护：内存中已有运行中的控制器时拒绝重复 resume，
    // 避免双流水线叠加并发（曾导致 LM Studio 队列堆积、重复写入与资源浪费）
    if (ctrl && ctrl.state === 'running') {
      return reply.status(409).send({ success: false, error: '该评测已在运行中，无需重复恢复' });
    }

    // 否则是异常中断后的恢复（进程重启等）
    const run = await prisma.evalRun.findUnique({
      where: { id },
      include: { modelConfig: true },
    });
    if (!run) {
      return reply.status(404).send({ success: false, error: '评测不存在' });
    }
    // 允许 paused、failed 状态恢复；也允许 running 但控制器已丢失的孤儿恢复
    if (run.status !== 'paused' && run.status !== 'failed' && run.status !== 'running') {
      return reply.status(400).send({ success: false, error: `当前状态 ${run.status} 不可恢复` });
    }
    // running 状态但无控制器 → 孤儿运行，标记 failed 后允许恢复
    if (run.status === 'running') {
      await prisma.evalRun.update({ where: { id }, data: { status: 'failed' } });
    }

    // ===== DB 可写性检查：防止多实例导致 SQLite 只读锁定 =====
    try {
      await prisma.evalRun.update({ where: { id }, data: { updatedAt: new Date() } });
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.error('[Resume] DB write test failed:', msg);
      return reply.status(500).send({
        success: false,
        error: `数据库写入失败（可能被其他进程锁定）：${msg}。请先停止所有服务器实例后重试。`,
      });
    }

    const config = JSON.parse(run.config) as EvalRunConfig;

    // 构建 Judge 配置（优先还原 run 创建时固化的 Judge，避免重启后 findFirst 选错）
    let judgeOptions: import('@zxbench/core').JudgeOptions | undefined;
    if (config.judgeEnabled) {
      const judgeRow = config.judgeModelConfigId
        ? await prisma.modelConfig.findUnique({ where: { id: config.judgeModelConfigId } })
        : await prisma.modelConfig.findFirst({ where: { modelType: 'judge' } });
      if (judgeRow) {
        judgeOptions = {
          localModel: {
            id: judgeRow.id,
            name: judgeRow.name,
            provider: judgeRow.provider,
            baseUrl: judgeRow.baseUrl,
            apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
            defaultParams: JSON.parse(judgeRow.defaultParams),
            reasoningModel: judgeRow.reasoningModel,
          },
          escalationThreshold: config.escalationThreshold || 0.85,
        };
      }
    }

    // 注册新控制器（替换可能存在的旧控制器）
    const resumeCtrl: EvalRunController = { state: 'running', resumePromise: null, resumeResolve: null, completionPromise: null, completionResolve: null };
    resumeCtrl.completionPromise = new Promise<void>((resolve) => { resumeCtrl.completionResolve = resolve; });
    evalControllers.set(run.id, resumeCtrl);

    // 后台恢复执行
    runEvaluation(run.id, run.modelConfig, config, judgeOptions).catch((err) => {
      console.error('Resume evaluation failed:', err);
      prisma.evalRun.update({
        where: { id: run.id },
        data: { status: 'failed' },
      }).catch(console.error);
    });

    return { success: true, data: { id: run.id, status: 'resuming' } };
  });

  // ===== 添加维度并行测试：合并到同一 Run =====
  app.post('/api/runs/:id/fork', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { dimensionIds } = request.body as { dimensionIds?: string[] };

    if (!dimensionIds || dimensionIds.length === 0) {
      return reply.status(400).send({ success: false, error: '请选择要添加的维度' });
    }

    const parentRun = await prisma.evalRun.findUnique({
      where: { id },
      include: { modelConfig: true },
    });
    if (!parentRun) {
      return reply.status(404).send({ success: false, error: '父评测不存在' });
    }

    const config = JSON.parse(parentRun.config) as EvalRunConfig;

    // 合并新维度到父运行的 dimensionFilter
    let existingFilter: string[] = [];
    if (parentRun.dimensionFilter) {
      try { existingFilter = JSON.parse(parentRun.dimensionFilter); } catch { /* ignore */ }
    }
    const allDimensions = ['program', 'safety_authority', 'agent_workflow', 'tool_cli_workflow', 'cli_deep_tasks', 'data_extraction', 'instruction_following', 'reasoning_math', 'structured_output', 'hallucination_resistance'];
    // 父运行若是全量（dimensionFilter 为空），fork 不应把范围收窄到所选子集，必须保持全量 404 题
    const newDimensionFilter = existingFilter.length === 0
      ? null
      : (() => {
          const mergedFilter = [...new Set([...existingFilter, ...dimensionIds])];
          // 如果全部 9 个维度都被选中，清除 filter（表示跑全部 404 题）
          return mergedFilter.length >= allDimensions.length ? null : JSON.stringify(mergedFilter);
        })();

    await prisma.evalRun.update({
      where: { id },
      data: { dimensionFilter: newDimensionFilter },
    });

    // 构建 Judge 配置（优先还原父运行固化的 Judge）
    let judgeOptions: import('@zxbench/core').JudgeOptions | undefined;
    if (config.judgeEnabled) {
      const judgeRow = config.judgeModelConfigId
        ? await prisma.modelConfig.findUnique({ where: { id: config.judgeModelConfigId } })
        : await prisma.modelConfig.findFirst({ where: { modelType: 'judge' } });
      if (judgeRow) {
        judgeOptions = {
          localModel: {
            id: judgeRow.id,
            name: judgeRow.name,
            provider: judgeRow.provider,
            baseUrl: judgeRow.baseUrl,
            apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
            defaultParams: JSON.parse(judgeRow.defaultParams),
            reasoningModel: judgeRow.reasoningModel,
          },
          escalationThreshold: config.escalationThreshold || 0.85,
        };
      }
    }

    // 如果当前有评测在运行，先停止它（restart 模式）
    const existingCtrl = evalControllers.get(id);
    if (existingCtrl) {
      existingCtrl.restartRequested = true;
      existingCtrl.state = 'cancelled';
      // 如果在暂停状态，先 resume 以解锁 worker
      if (existingCtrl.resumeResolve) {
        existingCtrl.resumeResolve();
        existingCtrl.resumeResolve = null;
      }
      // 等待当前评测退出（最多等 120 秒）
      if (existingCtrl.completionPromise) {
        try {
          await Promise.race([
            existingCtrl.completionPromise,
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 120000)),
          ]);
        } catch {
          console.warn(`[Fork] Waiting for evaluation ${id} to stop timed out, proceeding anyway`);
        }
      }
    }

    // 注册新控制器
    const newCtrl: EvalRunController = { state: 'running', resumePromise: null, resumeResolve: null, completionPromise: null, completionResolve: null };
    newCtrl.completionPromise = new Promise<void>((resolve) => { newCtrl.completionResolve = resolve; });
    evalControllers.set(id, newCtrl);

    // 立即回复前端
    reply.send({ success: true, data: { id, status: 'running' } });

    // 后台启动评测（读取更新后的 dimensionFilter，断点续测）
    runEvaluation(id, parentRun.modelConfig, config, judgeOptions).catch((err) => {
      console.error('Fork evaluation failed:', err);
      prisma.evalRun.update({ where: { id }, data: { status: 'failed' } }).catch(console.error);
    });
  });

  // ===== 获取同组所有运行的聚合进度 =====
  app.get('/api/runs/:id/group-progress', async (request) => {
    const { id } = request.params as { id: string };
    const run = await prisma.evalRun.findUnique({ where: { id } });
    if (!run) return { success: false, error: 'Run not found' };

    const groupName = run.groupName;
    if (!groupName) {
      // 没有分组，返回单个运行的进度
      const cached = getLatestProgress(id);
      if (cached && cached.total > 0) {
        return { success: true, data: { runs: [{ id, progress: cached }], aggregated: cached } };
      }
      return { success: false, error: 'No progress data' };
    }

    // 获取同组所有运行
    const groupRuns = await prisma.evalRun.findMany({
      where: { groupName },
      orderBy: { createdAt: 'asc' },
    });

    const runProgresses: Array<{ id: string; name: string; status: string; dimensionFilter?: string[]; progress?: EvalProgress }> = [];
    // 按维度去重：每个维度只取一个运行的数据（优先 completed > running > failed > paused）
    const statusPriority: Record<string, number> = { completed: 4, running: 3, failed: 2, paused: 1, cancelled: 0, pending: 0 };
    const dimBestRun = new Map<string, { dp: DimensionProgress; runStatus: string; recent: QuestionLiveResult[] }>();
    const seenScenarioIds = new Set<string>();
    const allRecent: QuestionLiveResult[] = [];

    for (const gr of groupRuns) {
      const cached = getLatestProgress(gr.id);
      if (cached && cached.total > 0) {
        runProgresses.push({
          id: gr.id,
          name: gr.name,
          status: gr.status,
          dimensionFilter: gr.dimensionFilter ? JSON.parse(gr.dimensionFilter) : undefined,
          progress: cached,
        });

        // 按维度去重：每个维度只保留最佳运行的数据
        for (const dp of cached.dimensionProgress || []) {
          const candidate = { dp: { ...dp, scores: [...dp.scores] }, runStatus: gr.status, recent: cached.recentResults || [] };
          const existing = dimBestRun.get(dp.dimension);
          if (!existing) {
            dimBestRun.set(dp.dimension, candidate);
          } else {
            const existingPri = statusPriority[existing.runStatus] ?? 0;
            const candidatePri = statusPriority[candidate.runStatus] ?? 0;
            // 优先选择 completed 运行；同优先级时选 completed 题目更多的
            if (candidatePri > existingPri || (candidatePri === existingPri && dp.completed > existing.dp.completed)) {
              dimBestRun.set(dp.dimension, candidate);
            }
          }
        }

        // 收集最近结果（按 scenarioId 去重）
        for (const r of cached.recentResults || []) {
          if (!seenScenarioIds.has(r.scenarioId)) {
            seenScenarioIds.add(r.scenarioId);
            allRecent.push(r);
          }
        }
      } else {
        // 缓存丢失，从数据库重建进度（含 dimensionProgress）
        try {
          const grDimFilter: string[] | null = gr.dimensionFilter ? JSON.parse(gr.dimensionFilter) : null;

          // 统计已完成的结果（带维度统计）
          const results = await prisma.scenarioResult.findMany({
            where: { evalRunId: gr.id },
            select: { scenarioId: true, dimension: true, totalScore: true, safetyLevel: true, environmentError: true },
          });

          // 构建维度进度
          const grDimMap = new Map<string, { total: number; completed: number; passed: number; failed: number; redLine: number; scores: number[] }>();
          // 先填充所有维度（基于总题目）
          const allValidScenarios = await prisma.scenarioDefinition.findMany({ where: { status: 'valid' } });
          for (const s of allValidScenarios) {
            if (grDimFilter && grDimFilter.length > 0 && !grDimFilter.includes(s.dimension)) continue;
            if (!grDimMap.has(s.dimension)) {
              grDimMap.set(s.dimension, { total: 0, completed: 0, passed: 0, failed: 0, redLine: 0, scores: [] });
            }
            grDimMap.get(s.dimension)!.total++;
          }
          // 填充完成数据（按 scenarioId 去重，避免重试重复行虚高计数）
          const grCounted = new Map<string, Set<string>>();
          for (const r of results) {
            if (r.environmentError === true) continue;  // 环境故障隔离：不计入维度统计
            if (!grCounted.has(r.dimension)) grCounted.set(r.dimension, new Set());
            const grSeen = grCounted.get(r.dimension)!;
            if (grSeen.has(r.scenarioId)) continue;
            grSeen.add(r.scenarioId);
            const ds = grDimMap.get(r.dimension);
            if (ds) {
              ds.completed++;
              ds.scores.push(r.totalScore);
              if (r.safetyLevel === 'red_line') ds.redLine++;
              if (r.totalScore >= 60) ds.passed++;
              else ds.failed++;
            }
          }
          const grDimProgress: DimensionProgress[] = [];
          for (const [dim, stats] of grDimMap) {
            grDimProgress.push({
              dimension: dim,
              total: stats.total,
              completed: stats.completed,
              passed: stats.passed,
              failed: stats.failed,
              redLine: stats.redLine,
              avgScore: stats.scores.length > 0 ? Math.round(stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length) : 0,
              scores: [...stats.scores],
            });
          }

          runProgresses.push({
            id: gr.id,
            name: gr.name,
            status: gr.status,
            dimensionFilter: grDimFilter || undefined,
          });

          // 按维度去重
          for (const dp of grDimProgress) {
            const candidate = { dp: { ...dp, scores: [...dp.scores] }, runStatus: gr.status, recent: [] as QuestionLiveResult[] };
            const existing = dimBestRun.get(dp.dimension);
            if (!existing) {
              dimBestRun.set(dp.dimension, candidate);
            } else {
              const existingPri = statusPriority[existing.runStatus] ?? 0;
              const candidatePri = statusPriority[candidate.runStatus] ?? 0;
              if (candidatePri > existingPri || (candidatePri === existingPri && dp.completed > existing.dp.completed)) {
                dimBestRun.set(dp.dimension, candidate);
              }
            }
          }
        } catch { /* ignore */ }
      }
    }

    // 构建去重后的维度进度
    const mergedDimProgress: DimensionProgress[] = [...dimBestRun.values()].map(v => v.dp);
    mergedDimProgress.sort((a, b) => a.dimension.localeCompare(b.dimension));

    // 总数 = 各维度 total 之和（不再跨运行累加）
    const totalScenarios = mergedDimProgress.reduce((sum, dp) => sum + dp.total, 0);
    const totalCompleted = mergedDimProgress.reduce((sum, dp) => sum + dp.completed, 0);

    const aggregated: EvalProgress = {
      runId: id,
      status: (groupRuns.some((r: { status: string }) => r.status === 'running') ? 'running'
        : groupRuns.some((r: { status: string }) => r.status === 'paused') ? 'paused'
        : groupRuns.some((r: { status: string }) => r.status === 'failed') ? 'failed'
        : groupRuns.every((r: { status: string }) => r.status === 'completed' || r.status === 'cancelled') ? 'completed'
        : 'pending') as EvalProgress['status'],
      total: totalScenarios > 0 ? totalScenarios : 1,
      completed: totalCompleted,
      percentage: totalScenarios > 0 ? Math.round((totalCompleted / totalScenarios) * 100) : 0,
      currentStage: 'running' as EvalStage,
      dimensionProgress: mergedDimProgress,
      recentResults: allRecent.sort((a, b) => b.totalScore - a.totalScore).slice(0, 50),
    };

    return { success: true, data: { runs: runProgresses, aggregated } };
  });

  // ===== 多模型并行：批量任务统一汇总（各模型独立进度 + 组级耗时） =====
  app.get('/api/runs/batch/:groupName', async (request) => {
    const { groupName } = request.params as { groupName: string };
    const groupRuns = await prisma.evalRun.findMany({
      where: { groupName },
      orderBy: { createdAt: 'asc' },
      include: { modelConfig: true },
    });
    if (groupRuns.length === 0) {
      return { success: false, error: '未找到该批量任务（可能 groupName 不存在）' };
    }

    // 预加载全部 valid 题目，用于按 dimensionFilter 计算各运行总题数
    const allValid = await prisma.scenarioDefinition.findMany({ where: { status: 'valid' } });

    const runs: BatchRunStatus[] = [];
    let groupStartMs: number | null = null;
    let groupEndMs: number | null = null;

    for (const r of groupRuns) {
      const dimFilter = r.dimensionFilter ? (JSON.parse(r.dimensionFilter) as string[]) : null;
      const cached = getLatestProgress(r.id);

      let total = 0;
      let completed = 0;
      let percentage = 0;
      let dimensionProgress: DimensionProgress[] | undefined;

      if (cached && cached.total > 0) {
        total = cached.total;
        completed = cached.completed;
        percentage = cached.percentage;
        dimensionProgress = cached.dimensionProgress;
      } else {
        // 缓存丢失：从 DB 重建（与 group-progress 逻辑一致，按 scenarioId 去重）
        const scopedScenarios = dimFilter && dimFilter.length > 0
          ? allValid.filter((s) => dimFilter.includes(s.dimension))
          : allValid;
        const baseTotal = scopedScenarios.length;
        const results = await prisma.scenarioResult.findMany({
          where: { evalRunId: r.id },
          select: { scenarioId: true, dimension: true, totalScore: true, safetyLevel: true },
        });
        const dimStats = new Map<string, { total: number; completed: number; passed: number; failed: number; redLine: number; scores: number[] }>();
        for (const s of scopedScenarios) {
          if (!dimStats.has(s.dimension)) dimStats.set(s.dimension, { total: 0, completed: 0, passed: 0, failed: 0, redLine: 0, scores: [] });
          dimStats.get(s.dimension)!.total++;
        }
        const seen = new Set<string>();
        let done = 0;
        for (const res of results) {
          if (seen.has(res.scenarioId)) continue;
          seen.add(res.scenarioId);
          done++;
          const ds = dimStats.get(res.dimension);
          if (ds) {
            ds.completed++;
            ds.scores.push(res.totalScore);
            if (res.safetyLevel === 'red_line') ds.redLine++;
            if (res.totalScore >= 60) ds.passed++; else ds.failed++;
          }
        }
        total = baseTotal;
        completed = done;
        percentage = baseTotal > 0 ? Math.round((done / baseTotal) * 100) : 0;
        dimensionProgress = [...dimStats.entries()].map(([dim, st]) => ({
          dimension: dim, total: st.total, completed: st.completed, passed: st.passed, failed: st.failed, redLine: st.redLine,
          avgScore: st.scores.length > 0 ? Math.round(st.scores.reduce((a, b) => a + b, 0) / st.scores.length) : 0, scores: [...st.scores],
        })).sort((a, b) => a.dimension.localeCompare(b.dimension));
      }

      // summary 解析（已完成运行的分数/维度均分/耗时）
      let summary: BatchRunStatus['summary'] = null;
      if (r.summary) {
        try {
          const s = JSON.parse(r.summary) as Record<string, unknown>;
          summary = {
            averageScore: typeof s.averageScore === 'number' ? (s.averageScore as number) : 0,
            dimensionAverages: (s.dimensionAverages as Record<string, number>) || {},
            passCount: typeof s.passCount === 'number' ? (s.passCount as number) : 0,
            totalScenarios: typeof s.totalScenarios === 'number' ? (s.totalScenarios as number) : total,
            completedScenarios: typeof s.completedScenarios === 'number' ? (s.completedScenarios as number) : completed,
            durationMs: typeof s.durationMs === 'number' ? (s.durationMs as number) : null,
            startedAt: (s.startedAt as string) || null,
            finishedAt: (s.finishedAt as string) || null,
          };
        } catch { /* ignore */ }
      }

      const createdAtMs = new Date(r.createdAt).getTime();
      const updatedAtMs = new Date(r.updatedAt).getTime();
      let durationMs: number | null = null;
      if (r.status === 'completed' && summary?.durationMs != null) durationMs = summary.durationMs;
      else if (r.status === 'running' || r.status === 'paused') durationMs = Date.now() - createdAtMs;

      // 组级时间窗：最早开始 ~ 最晚结束
      if (groupStartMs == null || createdAtMs < groupStartMs) groupStartMs = createdAtMs;
      if (r.status === 'completed' && summary?.finishedAt) {
        const f = new Date(summary.finishedAt).getTime();
        if (groupEndMs == null || f > groupEndMs) groupEndMs = f;
      }

      runs.push({
        id: r.id,
        name: r.name,
        modelConfigId: r.modelConfigId,
        modelName: r.modelConfig?.name || '',
        status: r.status,
        total, completed, percentage,
        dimensionProgress,
        summary,
        durationMs,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    const completedCount = runs.filter((x) => x.status === 'completed').length;
    const runningCount = runs.filter((x) => x.status === 'running').length;
    const failedCount = runs.filter((x) => x.status === 'failed').length;
    const groupDurationMs = (groupStartMs != null && groupEndMs != null) ? groupEndMs - groupStartMs
      : (groupStartMs != null ? Date.now() - groupStartMs : null);

    const data: BatchProgressResponse = {
      groupName,
      totalModels: runs.length,
      completedCount,
      runningCount,
      failedCount,
      groupStartedAt: groupStartMs ? new Date(groupStartMs).toISOString() : null,
      groupFinishedAt: groupEndMs ? new Date(groupEndMs).toISOString() : null,
      groupDurationMs,
      runs,
    };
    return { success: true, data };
  });

  // ===== 获取评测实时进度（REST 方式，供 WS 不可用时使用） =====
  app.get('/api/runs/:id/progress', async (request) => {
    const { id } = request.params as { id: string };
    const cached = getLatestProgress(id);
    // 仅当缓存有实际数据时才返回（total > 0 表示有真实进度）
    if (cached && cached.total > 0) {
      return { success: true, data: cached };
    }
    // 如果内存中没有缓存，尝试从数据库重建
    const run = await prisma.evalRun.findUnique({
      where: { id },
      include: { results: { orderBy: { startedAt: 'desc' }, take: 50 } },
    });
    if (!run) return { success: false, error: 'Run not found' };

    const allScenarios = await prisma.scenarioDefinition.findMany({ where: { status: 'valid' } });
    const dimMap = new Map<string, { total: number; completed: number; passed: number; failed: number; redLine: number; scores: number[] }>();
    for (const s of allScenarios) {
      if (!dimMap.has(s.dimension)) {
        dimMap.set(s.dimension, { total: 0, completed: 0, passed: 0, failed: 0, redLine: 0, scores: [] });
      }
      dimMap.get(s.dimension)!.total++;
    }
    for (const r of run.results) {
      const dimStats = dimMap.get(r.dimension);
      if (dimStats) {
        dimStats.completed++;
        dimStats.scores.push(r.totalScore);
        if (r.safetyLevel === 'red_line') dimStats.redLine++;
        if (r.totalScore >= 60) dimStats.passed++;
        else dimStats.failed++;
      }
    }

    const dimensionProgress: DimensionProgress[] = [];
    for (const [dim, stats] of dimMap) {
      const avgScore = stats.scores.length > 0
        ? Math.round(stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length)
        : 0;
      dimensionProgress.push({
        dimension: dim,
        total: stats.total,
        completed: stats.completed,
        passed: stats.passed,
        failed: stats.failed,
        redLine: stats.redLine,
        avgScore,
        scores: [...stats.scores],
      });
    }
    dimensionProgress.sort((a, b) => a.dimension.localeCompare(b.dimension));

    const progress: EvalProgress = {
      runId: id,
      status: run.status as 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
      total: allScenarios.length,
      completed: run.results.length,
      percentage: allScenarios.length > 0 ? Math.round((run.results.length / allScenarios.length) * 100) : 0,
      currentStage: 'queued',
      dimensionProgress,
      recentResults: run.results.slice(0, 50).map((r) => ({
        scenarioId: r.scenarioId,
        dimension: r.dimension,
        difficulty: '',
        language: '',
        totalScore: r.totalScore,
        safetyLevel: r.safetyLevel as 'safe' | 'red_line',
        passed: r.totalScore >= 60,
        durationMs: 0,
        stage: 'completed' as const,
      })),
      current: undefined,
    };
    return { success: true, data: progress };
  });

  // ===== 题目管理 =====
  app.get('/api/scenarios', async (request) => {
    const { dimension, status } = request.query as { dimension?: string; status?: string };
    const where: Record<string, string> = {};
    if (dimension) where.dimension = dimension;
    if (status) where.status = status;

    const scenarios = await prisma.scenarioDefinition.findMany({ where });
    return {
      success: true,
      data: scenarios.map((s) => ({
        ...s,
        scoring: JSON.parse(s.scoring),
        hiddenTests: s.hiddenTests ? JSON.parse(s.hiddenTests) : null,
        requirements: s.requirements ? JSON.parse(s.requirements) : null,
        tags: s.tags ? JSON.parse(s.tags) : null,
      })),
    };
  });

  // 新增 / 更新单个题目（upsert）
  app.post('/api/scenarios', async (request, reply) => {
    const s = request.body as Record<string, unknown>;
    if (!s.id || !s.promptTemplate) {
      return reply.status(400).send({ success: false, error: 'id and promptTemplate are required' });
    }
    try {
      const data = {
        dimension: String(s.dimension || 'unknown'),
        category: String(s.category || 'general'),
        difficulty: String(s.difficulty || 'medium'),
        language: String(s.language || 'javascript'),
        locale: String(s.locale || 'zh-CN'),
        status: String(s.status || 'valid'),
        tier: String(s.tier || 'public_dev'),
        promptTemplate: String(s.promptTemplate),
        sourceCode: s.sourceCode ? String(s.sourceCode) : null,
        functionName: s.functionName ? String(s.functionName) : null,
        expectedVerdict: s.expectedVerdict ? String(s.expectedVerdict) : null,
        grader: String(s.grader || 'bug_finding_v2'),
        graderVersion: String(s.graderVersion || '2.0.0'),
        scoring: JSON.stringify(s.scoring || {}),
        hiddenTests: s.hiddenTests ? JSON.stringify(s.hiddenTests) : null,
        requirements: s.requirements ? JSON.stringify(s.requirements) : null,
        tags: s.tags ? JSON.stringify(s.tags) : null,
        scenarioVersion: String(s.scenarioVersion || '1.0.0'),
        scenarioHash: String(s.scenarioHash || ''),
      };
      // Phase 1 契约校验（宽松模式：不拒绝导入，仅返回报告供作者修复）
      const contractReport = validateScenario({
        id: String(s.id),
        dimension: data.dimension,
        category: data.category,
        difficulty: data.difficulty as 'easy' | 'medium' | 'hard' | 'adversarial',
        language: data.language,
        locale: data.locale,
        status: data.status as 'valid' | 'invalid' | 'ambiguous' | 'needs_context' | 'retired',
        tier: data.tier as 'public_dev' | 'private_validation' | 'blind_holdout',
        promptTemplate: data.promptTemplate,
        sourceCode: data.sourceCode ?? undefined,
        functionName: data.functionName ?? undefined,
        expectedVerdict: data.expectedVerdict as 'fix' | 'no_bug' | undefined,
        grader: data.grader,
        graderVersion: data.graderVersion,
        scoring: JSON.parse(data.scoring),
        hiddenTests: data.hiddenTests ? JSON.parse(data.hiddenTests) : undefined,
        requirements: data.requirements ? JSON.parse(data.requirements) : undefined,
        scenarioVersion: data.scenarioVersion,
        scenarioHash: data.scenarioHash,
      });

      const scenario = await prisma.scenarioDefinition.upsert({
        where: { id: String(s.id) },
        create: { id: String(s.id), ...data },
        update: data,
      });
      return {
        success: true,
        data: scenario,
        contractValidation: {
          eligible: contractReport.eligible,
          errors: contractReport.errors,
          warnings: contractReport.warnings,
        },
      };
    } catch (err) {
      return reply.status(500).send({ success: false, error: String(err) });
    }
  });

  // 删除题目
  app.delete('/api/scenarios/:id', async (request) => {
    const { id } = request.params as { id: string };
    await prisma.scenarioDefinition.delete({ where: { id } });
    return { success: true };
  });

  // ===== 统计 =====
  app.get('/api/stats', async () => {
    const totalRuns = await prisma.evalRun.count();
    const completedRuns = await prisma.evalRun.count({ where: { status: 'completed' } });
    const totalResults = await prisma.scenarioResult.count();
    const dimensions = await prisma.scenarioDefinition.groupBy({
      by: ['dimension'],
      _count: { id: true },
    });

    return {
      success: true,
      data: {
        totalRuns,
        completedRuns,
        totalResults,
        dimensions: dimensions.map((d) => ({ name: d.dimension, count: d._count.id })),
      },
    };
  });

  // ===== 导出 =====
  app.get('/api/runs/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { format } = request.query as { format?: string };
    const run = await prisma.evalRun.findUnique({
      where: { id },
      include: { modelConfig: true, results: { orderBy: { startedAt: 'asc' } } },
    });
    if (!run) return reply.status(404).send({ success: false, error: 'Not found' });

    const exportData = {
      ...run,
      config: JSON.parse(run.config),
      manifest: run.manifest ? JSON.parse(run.manifest) : null,
      summary: run.summary ? JSON.parse(run.summary) : null,
      // GPT5.6 P0-7: 导出时脱敏处理
      results: run.results.map((r) => maskSensitiveData(deserializeResult(r))),
      exportedAt: new Date().toISOString(),
    };

    if (format === 'csv') {
      const header = 'scenarioId,dimension,totalScore,safetyLevel,formatParseSuccess,escalated,runCount\n';
      const rows = exportData.results.map((r: Record<string, unknown>) =>
        `${r.scenarioId},${r.dimension},${r.totalScore},${r.safetyLevel},${r.formatParseSuccess},${r.escalated},${r.runCount}`
      ).join('\n');
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${run.id}.csv"`);
      return reply.send(header + rows);
    }

    if (format === 'markdown') {
      let md = `# ${run.name}\n\n`;
      md += `**Status**: ${run.status} | **Model**: ${run.modelConfig.name}\n\n`;
      md += `## Summary\n\n`;
      if (exportData.summary) {
        const s = exportData.summary as Record<string, number>;
        md += `- Total Scenarios: ${s.totalScenarios ?? 0}\n- Completed: ${s.completedScenarios ?? 0}\n- Average Score: ${s.averageScore ?? 0}\n- Safety Red Lines: ${s.safetyRedLineCount ?? 0}\n`;
      }
      md += `\n## Results\n\n| Scenario | Dimension | Score | Safety |\n|----------|-----------|-------|--------|\n`;
      for (const r of exportData.results) {
        const rr = r as Record<string, unknown>;
        md += `| ${rr.scenarioId} | ${rr.dimension} | ${rr.totalScore} | ${rr.safetyLevel} |\n`;
      }
      reply.header('Content-Type', 'text/markdown');
      return reply.send(md);
    }

    // Default: JSON
    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', `attachment; filename="${run.id}.json"`);
    return reply.send({ success: true, data: exportData });
  });

  // ===== 数据迁移（从 智秀大模型评测 导入） =====
  app.post('/api/migrate/scenarios', async (request) => {
    const body = request.body as { scenarios: Array<Record<string, unknown>> };
    if (!body.scenarios || !Array.isArray(body.scenarios)) {
      return { success: false, error: 'Expected { scenarios: [...] }' };
    }
    let imported = 0;
    for (const s of body.scenarios) {
      try {
        await prisma.scenarioDefinition.upsert({
          where: { id: String(s.id) },
          create: {
            id: String(s.id),
            dimension: String(s.dimension || 'unknown'),
            category: String(s.category || 'general'),
            difficulty: String(s.difficulty || 'medium'),
            language: String(s.language || 'javascript'),
            locale: String(s.locale || 'zh-CN'),
            status: String(s.status || 'valid'),
            tier: String(s.tier || 'public_dev'),
            promptTemplate: String(s.promptTemplate || ''),
            sourceCode: s.sourceCode ? String(s.sourceCode) : null,
            functionName: s.functionName ? String(s.functionName) : null,
            expectedVerdict: s.expectedVerdict ? String(s.expectedVerdict) : null,
            grader: String(s.grader || 'bug_finding_v2'),
            graderVersion: String(s.graderVersion || '2.0.0'),
            scoring: JSON.stringify(s.scoring || {}),
            hiddenTests: s.hiddenTests ? JSON.stringify(s.hiddenTests) : null,
            requirements: s.requirements ? JSON.stringify(s.requirements) : null,
            tags: s.tags ? JSON.stringify(s.tags) : null,
            scenarioVersion: String(s.scenarioVersion || '1.0.0'),
            scenarioHash: String(s.scenarioHash || ''),
          },
          update: {
            promptTemplate: String(s.promptTemplate || ''),
            scoring: JSON.stringify(s.scoring || {}),
            hiddenTests: s.hiddenTests ? JSON.stringify(s.hiddenTests) : null,
          },
        });
        imported++;
      } catch (err) {
        console.error(`Failed to import scenario ${s.id}:`, err);
      }
    }
    return { success: true, data: { imported, total: body.scenarios.length } };
  });

  // ===== 测试包导入（从 pack tar.gz URL 安装） =====
  // GPT5.6 P0-2: 禁止 require() 远程 JS，仅导入静态 JSON 数据
  // GPT5.6 P0-3: SSRF 防护 + 路径穿越防护 + 下载大小限制
  app.post('/api/migrate/pack', async (request, reply) => {
    const { url } = request.body as { url?: string };
    if (!url || !/^https?:\/\//.test(url)) {
      return reply.status(400).send({ success: false, error: 'url is required (http/https)' });
    }

    // SSRF 防护：验证 URL 目标安全
    const ssrfCheck = await validateUrlSafety(url);
    if (!ssrfCheck.safe) {
      return reply.status(400).send({ success: false, error: `URL 安全检查失败: ${ssrfCheck.reason}` });
    }

    // 从 URL 推断维度过滤
    const m = url.match(/zxbench-pro-(\w+)\.tar\.gz/);
    const short = m ? m[1] : 'all';
    const dimensionFilter = PACK_DIMENSION_MAP[short] ?? '';

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zxbench-pack-'));
    const tgzPath = path.join(tmpDir, 'pack.tar.gz');

    // 下载大小限制: 50MB
    const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;
    // 解压大小限制: 200MB
    const MAX_EXTRACT_SIZE = 200 * 1024 * 1024;
    // 最大文件数
    const MAX_FILES = 500;

    try {
      // 1. 下载（带大小限制）
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        return reply.status(400).send({ success: false, error: `下载失败: HTTP ${res.status}` });
      }

      // 检查 Content-Length
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_DOWNLOAD_SIZE) {
        return reply.status(400).send({ success: false, error: `文件过大: ${contentLength} bytes (限制 ${MAX_DOWNLOAD_SIZE})` });
      }

      // 流式下载并检查实际大小
      let downloadedBytes = 0;
      const reader = (res.body as unknown as NodeJS.ReadableStream);
      const writeStream = fs.createWriteStream(tgzPath);

      await new Promise<void>((resolve, reject) => {
        reader.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (downloadedBytes > MAX_DOWNLOAD_SIZE) {
            writeStream.destroy();
            reject(new Error(`下载超过大小限制: ${MAX_DOWNLOAD_SIZE} bytes`));
          }
        });
        reader.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        reader.pipe(writeStream);
      });

      // 2. 解压（系统 tar）
      // GPT5.6 P0-3: 使用 --no-same-owner --no-same-permissions 防止权限攻击
      const tarResult = spawnSync('tar', ['-xzf', tgzPath, '-C', tmpDir, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8' });
      if (tarResult.status !== 0) {
        return reply.status(500).send({ success: false, error: `解压失败: ${tarResult.stderr || tarResult.error}` });
      }

      // 3. 路径穿越检查：确保解压后所有文件都在 tmpDir 内
      const pathViolation = checkPathTraversal(tmpDir);
      if (pathViolation) {
        return reply.status(400).send({ success: false, error: `路径穿越检测: ${pathViolation}` });
      }

      // 4. 检查解压后文件数量和大小
      const extractStats = getDirectoryStats(tmpDir);
      if (extractStats.fileCount > MAX_FILES) {
        return reply.status(400).send({ success: false, error: `文件数量过多: ${extractStats.fileCount} (限制 ${MAX_FILES})` });
      }
      if (extractStats.totalSize > MAX_EXTRACT_SIZE) {
        return reply.status(400).send({ success: false, error: `解压后过大: ${extractStats.totalSize} bytes (限制 ${MAX_EXTRACT_SIZE})` });
      }

      // 5. 检查符号链接
      const symlinkCheck = checkSymlinks(tmpDir);
      if (symlinkCheck) {
        return reply.status(400).send({ success: false, error: `检测到符号链接（不允许）: ${symlinkCheck}` });
      }

      // 6. 定位 pack 根目录
      const packJsonPath = findPackJson(tmpDir);
      if (!packJsonPath) {
        return reply.status(400).send({ success: false, error: '未找到 zxbench.pack.json，不是有效的测试包' });
      }
      const packRoot = path.dirname(packJsonPath);
      const packMeta = JSON.parse(await fsp.readFile(packJsonPath, 'utf8'));

      // 7. GPT5.6 P0-2: 从静态 JSON 文件加载题目数据（禁止 require JS）
      const allScenarios = await loadScenariosFromStaticData(packRoot);

      // 8. 维度过滤 + 入库
      const scenarios = dimensionFilter
        ? allScenarios.filter((s) => s.dimension === dimensionFilter)
        : allScenarios;

      let imported = 0;
      const errors: string[] = [];
      for (const s of scenarios) {
        try {
          const expected = (s.expected || {}) as Record<string, unknown>;
          const tags = Array.isArray(s.tags) ? (s.tags as string[]) : [];
          const langTag = tags.find((t) => ['javascript', 'python', 'typescript', 'sql', 'bash', 'rust', 'go', 'java', 'c', 'cpp'].includes(t));

          // 隐藏/公开/回归测试 → 统一 HiddenTestCase 格式
          const hiddenTests: Array<Record<string, unknown>> = [];
          const testGroups: Array<[string, string]> = [
            ['publicTests', 'public'],
            ['hiddenTests', 'hidden'],
            ['regressionTests', 'regression'],
          ];
          for (const [field, type] of testGroups) {
            const list = expected[field];
            if (Array.isArray(list)) {
              list.forEach((t: Record<string, unknown>, i: number) => {
                hiddenTests.push({
                  id: `${s.id}-${type}-${i + 1}`,
                  type,
                  testCode: String(t.code || ''),
                  description: t.description ? String(t.description) : undefined,
                  expectedExitCode: 0,
                });
              });
            }
          }

          const data = {
            dimension: String(s.dimension || 'unknown'),
            category: String(s.category || 'general'),
            difficulty: String(s.difficulty || 'medium'),
            language: langTag || 'general',
            locale: String(s.locale || 'zh-CN'),
            status: 'valid',
            tier: 'public_dev',
            promptTemplate: String(s.promptTemplate || ''),
            sourceCode: expected.initialCode ? String(expected.initialCode) : null,
            functionName: expected.functionName ? String(expected.functionName) : null,
            expectedVerdict: null,
            grader: String(s.grader || 'unknown'),
            graderVersion: String(s.graderVersion || '1.0.0'),
            scoring: JSON.stringify(s.scoring || {}),
            hiddenTests: hiddenTests.length > 0 ? JSON.stringify(hiddenTests) : null,
            requirements: JSON.stringify(expected),
            tags: tags.length > 0 ? JSON.stringify(tags) : null,
            scenarioVersion: String(s.scenarioVersion || '1.0.0'),
            scenarioHash: String(s.id),
          };

          await prisma.scenarioDefinition.upsert({
            where: { id: String(s.id) },
            create: { id: String(s.id), ...data },
            update: data,
          });
          imported++;
        } catch (err) {
          errors.push(`${s.id}: ${String(err)}`);
        }
      }

      return {
        success: true,
        data: {
          packId: packMeta.id,
          packName: packMeta.name,
          packVersion: packMeta.version,
          dimensionFilter: dimensionFilter || 'all',
          imported,
          total: scenarios.length,
          skipped: allScenarios.length - scenarios.length,
          errors,
        },
      };
    } catch (err) {
      return reply.status(500).send({ success: false, error: String(err) });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ===== 评测报告 =====
  app.get('/api/runs/:id/report', async (request, reply) => {
    const { id } = request.params as { id: string };
    const lang = (request.query as { lang?: string }).lang === 'en' ? 'en' : 'zh';
    const run = await prisma.evalRun.findUnique({
      where: { id },
      include: { modelConfig: true },
    });
    if (!run) return reply.status(404).send({ success: false, error: 'Not found' });

    // 单次 run 聚合：只统计当前这次评测的结果（与实时监控/评测历史口径一致）
    const allRunIds = [id];

    // 真实基准总量（含维度范围），用于 totalScenarios
    const benchmarkTotal = await getBenchmarkScopeTotal([parseDimensionFilter(run.dimensionFilter)]);

    // 收集所有结果，按 scenarioId 去重取最高分
    const allResults = await prisma.scenarioResult.findMany({
      where: { evalRunId: { in: allRunIds } },
      select: {
        scenarioId: true, dimension: true, totalScore: true,
        deterministicScore: true, judgeScore: true,
        safetyLevel: true, axisScores: true, axisEvidence: true,
        formatParseSuccess: true, escalated: true,
        graderVersion: true, evidence: true,
        startedAt: true, finishedAt: true,
        outputMetadata: true,
        environmentError: true,
      },
    });

    const dedup = new Map<string, typeof allResults[number]>();
    const isEnvError = (r: { environmentError?: boolean | null }) => r.environmentError === true;
    for (const r of allResults) {
      const existing = dedup.get(r.scenarioId);
      // 优先非环境故障行（重试成功覆盖环境故障；同状态取高分）
      if (!existing
        || (isEnvError(existing) && !isEnvError(r))
        || (!isEnvError(existing) && !isEnvError(r) && r.totalScore > existing.totalScore)) {
        dedup.set(r.scenarioId, r);
      }
    }
    const results = Array.from(dedup.values());

    // 类别加权维度均分（三级计算：类别内平均 → 类别等权维度均分）
    const dimAvgMap = await computeDifficultyWeightedDimAvgs(
      results.map((r) => ({ scenarioId: r.scenarioId, dimension: r.dimension, totalScore: r.totalScore, environmentError: r.environmentError ?? undefined })),
    );
    // 单次 run 口径：维度分直接采用 run.summary.dimensionAverages（与评测历史/实时监控一致，避免重复行去重差异）
    let summaryJson: { averageScore?: number; dimensionAverages?: Record<string, number> } | null = null;
    try { summaryJson = run.summary ? JSON.parse(run.summary) : null; } catch { summaryJson = null; }
    if (summaryJson?.dimensionAverages) {
      for (const [dim, v] of Object.entries(summaryJson.dimensionAverages)) {
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n)) dimAvgMap.set(dim, n);
      }
    }

    // 按维度分组统计
    const dimMap = new Map<string, { scores: number[]; passed: number; failed: number; redLine: number; formatFail: number; scenarios: string[]; axisScores: Record<string, number[]>; evidence: Record<string, number> }>();
    for (const r of results) {
      if (r.environmentError === true) continue;  // 环境故障隔离：不进维度报告分布
      if (!dimMap.has(r.dimension)) {
        dimMap.set(r.dimension, { scores: [], passed: 0, failed: 0, redLine: 0, formatFail: 0, scenarios: [], axisScores: {}, evidence: { verified: 0, rule: 0, llm: 0, unmeasured: 0 } });
      }
      const d = dimMap.get(r.dimension)!;
      d.scores.push(r.totalScore);
      d.scenarios.push(r.scenarioId);
      if (r.totalScore >= 60) d.passed++; else d.failed++;
      if (r.safetyLevel === 'red' || r.safetyLevel === 'red_line') d.redLine++;
      if (!r.formatParseSuccess) d.formatFail++;
      try {
        const axes = JSON.parse(r.axisScores) as Record<string, number>;
        for (const [k, v] of Object.entries(axes)) {
          if (!d.axisScores[k]) d.axisScores[k] = [];
          d.axisScores[k].push(v);
        }
      } catch { /* ignore */ }
      // 证据强度统计（披露：各维度多少权重的分数来自哪类证据）
      try {
        if (r.axisEvidence) {
          const ev = JSON.parse(r.axisEvidence) as Record<string, string>;
          const counted = new Set<string>();
          for (const [k, v] of Object.entries(ev)) {
            if (counted.has(k)) continue; // 去重（多题聚合时每轴只计一次）
            counted.add(k);
            if (v === 'verified' || v === 'rule' || v === 'llm' || v === 'unmeasured') {
              d.evidence[v]++;
            }
          }
        }
      } catch { /* ignore */ }
    }

    // 构建维度报告
    const dimensionReports = Array.from(dimMap.entries()).map(([dim, d]) => {
      const avg = Math.round((dimAvgMap.get(dim) || 0) * 100) / 100;
      const max = d.scores.length > 0 ? Math.max(...d.scores) : 0;
      const min = d.scores.length > 0 ? Math.min(...d.scores) : 0;
      const sorted = [...d.scores].sort((a, b) => a - b);
      const median = sorted.length > 0 ? (sorted.length % 2 === 0 ? Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : sorted[Math.floor(sorted.length / 2)]) : 0;
      const distribution = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
      for (const s of d.scores) {
        if (s <= 20) distribution['0-20']++;
        else if (s <= 40) distribution['21-40']++;
        else if (s <= 60) distribution['41-60']++;
        else if (s <= 80) distribution['61-80']++;
        else distribution['81-100']++;
      }
      const axisAvg: Record<string, number> = {};
      for (const [k, vals] of Object.entries(d.axisScores)) {
        axisAvg[k] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      }
      return {
        dimension: dim,
        dimensionLabel: dimensionLabelFor(dim, lang),
        count: d.scores.length,
        averageScore: avg,
        maxScore: max,
        minScore: min,
        medianScore: median,
        passRate: d.scores.length > 0 ? Math.round((d.passed / d.scores.length) * 100) : 0,
        passCount: d.passed,
        failCount: d.failed,
        redLineCount: d.redLine,
        formatFailCount: d.formatFail,
        distribution,
        axisAvg,
        evidence: d.evidence, // 证据强度披露：verified/rule/llm/unmeasured 轴数
      };
    }).sort((a, b) => b.averageScore - a.averageScore);

    // ===== 幻觉抵抗维度专用统计：HRS + Over-refusal + 标签分布 =====
    let hallucinationStats: {
      hrs: number;
      overRefusalRate: number;
      answerableCount: number;
      labelDistribution: Record<string, number>;
    } | null = null;
    const halResults = results.filter((r) => r.dimension === 'hallucination_resistance');
    if (halResults.length > 0) {
      // 读取题目的 answerability 标注
      const halIds = halResults.map((r) => r.scenarioId);
      const halDefs = await prisma.scenarioDefinition.findMany({
        where: { id: { in: halIds } },
        select: { id: true, requirements: true },
      });
      const answerabilityMap = new Map<string, string>();
      for (const def of halDefs) {
        try {
          const req = (def.requirements ? JSON.parse(def.requirements) : {}) as { answerability?: string };
          answerabilityMap.set(def.id, req.answerability || 'ANSWERABLE');
        } catch { answerabilityMap.set(def.id, 'ANSWERABLE'); }
      }

      const labelDistribution: Record<string, number> = {
        correct: 0, correct_refusal: 0, partial: 0,
        hallucination: 0, wrong_refusal: 0, accepted_false_premise: 0,
      };
      let answerableCount = 0;
      let wrongRefusalCount = 0;
      let hrsSum = 0;

      for (const r of halResults) {
        hrsSum += r.totalScore;
        const answerability = answerabilityMap.get(r.scenarioId) || 'ANSWERABLE';
        if (answerability === 'ANSWERABLE') answerableCount++;

        let label = 'hallucination';
        try {
          const ev = JSON.parse(r.evidence) as string[];
          const found = ev.find((e) => e.startsWith('HALLUCINATION_LABEL:'));
          if (found) label = found.split(':')[1];
        } catch { /* ignore */ }

        labelDistribution[label] = (labelDistribution[label] || 0) + 1;
        if (label === 'wrong_refusal') wrongRefusalCount++;
      }

      hallucinationStats = {
        hrs: Math.round((hrsSum / halResults.length) * 10) / 10,
        overRefusalRate: answerableCount > 0 ? Math.round((wrongRefusalCount / answerableCount) * 100) : 0,
        answerableCount,
        labelDistribution,
      };
    }

    // 全局统计 — 维度加权总分（使用引擎定义的 DIMENSION_WEIGHTS）；单次 run 口径直接用 summary.averageScore
    const allScores = results.filter((r) => r.environmentError !== true).map((r) => r.totalScore);
    const totalAvg = (summaryJson && typeof summaryJson.averageScore === 'number')
      ? summaryJson.averageScore
      : computeWeightedTotal(dimAvgMap);
    const totalPass = allScores.filter((s) => s >= 60).length;
    const totalRedLine = results.filter((r) => r.environmentError !== true && (r.safetyLevel === 'red' || r.safetyLevel === 'red_line')).length;
    const totalFormatFail = results.filter((r) => r.environmentError !== true && !r.formatParseSuccess).length;

    const globalDist = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
    for (const s of allScores) {
      if (s <= 20) globalDist['0-20']++;
      else if (s <= 40) globalDist['21-40']++;
      else if (s <= 60) globalDist['41-60']++;
      else if (s <= 80) globalDist['61-80']++;
      else globalDist['81-100']++;
    }

    const strengths = dimensionReports.filter((d) => d.averageScore >= 75).slice(0, 3);
    const weaknesses = dimensionReports.filter((d) => d.averageScore < 65).slice(-3).reverse();

    const config = JSON.parse(run.config) as Record<string, unknown>;
    const modelInfo = {
      name: run.modelConfig.name,
      provider: run.modelConfig.provider,
      baseUrl: run.modelConfig.baseUrl,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      runsPerQuestion: config.runsPerQuestion,
      judgeEnabled: config.judgeEnabled,
    };

    // Token 速度统计 — 按每题独立计算再取均值，消除并行执行叠加偏差
    let reportInputTokens = 0;
    let reportOutputTokens = 0;
    const perQuestionSpeeds: number[] = [];
    for (const r of results) {
      try {
        const meta = r.outputMetadata ? JSON.parse(r.outputMetadata) : null;
        if (meta) {
          reportInputTokens += meta.inputTokens || 0;
          reportOutputTokens += meta.outputTokens || 0;
          // 优先使用预计算的 tokenSpeed，其次用 nativeTokensPerSecond，最后用 inferenceMs 推算
          const speed = meta.tokenSpeed
            || meta.nativeTokensPerSecond
            || (meta.inferenceMs && meta.outputTokens ? Math.round(meta.outputTokens / (meta.inferenceMs / 1000)) : 0);
          if (speed > 0) perQuestionSpeeds.push(speed);
        }
      } catch { /* ignore */ }
    }
    // 兜底：本地 GGUF（llama.cpp）API 上报的 token 偏低，用 summary 里重算后的值覆盖
    try {
      const _s = run.summary ? JSON.parse(run.summary) : null;
      if (_s) {
        reportInputTokens = Math.max(reportInputTokens, _s.totalInputTokens || 0);
        reportOutputTokens = Math.max(reportOutputTokens, _s.totalOutputTokens || 0);
      }
    } catch { /* ignore */ }
    // 中位数避免极端值（超长题/超短题）歪曲均值
    const sortedSpeeds = perQuestionSpeeds.sort((a, b) => a - b);
    const avgTokensPerSecond = perQuestionSpeeds.length > 0
      ? Math.round(sortedSpeeds[Math.floor(sortedSpeeds.length / 2)])
      : 0;

    return {
      success: true,
      data: {
        runId: run.id,
        runName: run.name,
        runStatus: run.status,
        createdAt: run.createdAt,
        reportContent: run.reportContent || null,
        model: modelInfo,
        totalScenarios: benchmarkTotal,
        completedScenarios: results.length,
        missingScenarios: Math.max(0, benchmarkTotal - results.length),
        averageScore: totalAvg,
        passRate: allScores.length > 0 ? Math.round((totalPass / allScores.length) * 100) : 0,
        passCount: totalPass,
        redLineCount: totalRedLine,
        formatFailCount: totalFormatFail,
        globalDistribution: globalDist,
        dimensions: dimensionReports,
        hallucinationStats,
        // 全局证据强度摘要（全部结果的轴证据类型分布）
        evidenceSummary: dimensionReports.reduce<Record<string, number>>(
          (acc, d) => {
            for (const [k, v] of Object.entries(d.evidence)) acc[k] = (acc[k] || 0) + v;
            return acc;
          },
          { verified: 0, rule: 0, llm: 0, unmeasured: 0 },
        ),
        strengths: strengths.map((s) => ({ dimension: s.dimensionLabel, score: s.averageScore, passRate: s.passRate })),
        weaknesses: weaknesses.map((w) => ({ dimension: w.dimensionLabel, score: w.averageScore, passRate: w.passRate })),
        radarData: dimensionReports.map((d) => ({ name: d.dimensionLabel, value: d.averageScore })),
        tokenStats: {
          totalInputTokens: reportInputTokens,
          totalOutputTokens: reportOutputTokens,
          totalTokens: reportInputTokens + reportOutputTokens,
          avgTokensPerSecond,
        },
      },
    };
  });

  // ===== AI 报告生成 =====
  app.post('/api/runs/:id/report/generate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const lang = (request.body as { language?: string } | undefined)?.language === 'en' ? 'en' : 'zh';

    // 获取运行记录
    const run = await prisma.evalRun.findUnique({
      where: { id },
      include: { modelConfig: true },
    });
    if (!run) return reply.status(404).send({ success: false, error: 'Run not found' });
    if (run.status !== 'completed') {
      return reply.status(400).send({ success: false, error: '评测尚未完成，无法生成报告' });
    }

    // 获取 Judge 模型
    const judgeRow = await prisma.modelConfig.findFirst({ where: { modelType: 'judge' } });
    if (!judgeRow) {
      return reply.status(500).send({ success: false, error: '未配置 AI Judge 模型，无法生成报告' });
    }

    const judgeConfig: ModelConfig = {
      id: judgeRow.id,
      name: judgeRow.name,
      provider: judgeRow.provider,
      baseUrl: judgeRow.baseUrl,
      apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
      defaultParams: JSON.parse(judgeRow.defaultParams),
      modelType: 'judge',
      reasoningModel: judgeRow.reasoningModel,
    };

    try {
      // 单次 run 聚合：只统计当前这次评测的结果（与实时监控/评测历史口径一致）
      const allRunIds = [id];
      const benchmarkTotal = await getBenchmarkScopeTotal([parseDimensionFilter(run.dimensionFilter)]);

      const allResults = await prisma.scenarioResult.findMany({
        where: { evalRunId: { in: allRunIds } },
        select: {
          scenarioId: true, dimension: true, totalScore: true,
          deterministicScore: true, judgeScore: true,
          safetyLevel: true, axisScores: true,
          formatParseSuccess: true, escalated: true,
          evidence: true, outputMetadata: true,
          startedAt: true, finishedAt: true,
          environmentError: true,
        },
      });

      const dedup = new Map<string, typeof allResults[number]>();
      const isEnvError = (r: { environmentError?: boolean | null }) => r.environmentError === true;
      for (const r of allResults) {
        const existing = dedup.get(r.scenarioId);
        // 优先非环境故障行（重试成功覆盖环境故障；同状态取高分）
        if (!existing
          || (isEnvError(existing) && !isEnvError(r))
          || (!isEnvError(existing) && !isEnvError(r) && r.totalScore > existing.totalScore)) {
          dedup.set(r.scenarioId, r);
        }
      }
      const results = Array.from(dedup.values());

      // 类别加权维度均分（三级计算：类别内平均 → 类别等权维度均分）
      const dimAvgMap2 = await computeDifficultyWeightedDimAvgs(
        results.map((r) => ({ scenarioId: r.scenarioId, dimension: r.dimension, totalScore: r.totalScore, environmentError: r.environmentError ?? undefined })),
      );
      // 单次 run 口径：维度分直接采用 run.summary.dimensionAverages
      let summaryJson2: { averageScore?: number; dimensionAverages?: Record<string, number> } | null = null;
      try { summaryJson2 = run.summary ? JSON.parse(run.summary) : null; } catch { summaryJson2 = null; }
      if (summaryJson2?.dimensionAverages) {
        for (const [dim, v] of Object.entries(summaryJson2.dimensionAverages)) {
          const n = typeof v === 'number' ? v : Number(v);
          if (Number.isFinite(n)) dimAvgMap2.set(dim, n);
        }
      }

      // 构建维度报告（与 GET /api/runs/:id/report 逻辑一致）
      const dimMap = new Map<string, { scores: number[]; passed: number; failed: number; redLine: number; formatFail: number; axisScores: Record<string, number[]> }>();
      for (const r of results) {
        if (r.environmentError === true) continue;  // 环境故障隔离：不进维度分布
        if (!dimMap.has(r.dimension)) {
          dimMap.set(r.dimension, { scores: [], passed: 0, failed: 0, redLine: 0, formatFail: 0, axisScores: {} });
        }
        const d = dimMap.get(r.dimension)!;
        d.scores.push(r.totalScore);
        if (r.totalScore >= 60) d.passed++; else d.failed++;
        if (r.safetyLevel === 'red' || r.safetyLevel === 'red_line') d.redLine++;
        if (!r.formatParseSuccess) d.formatFail++;
        try {
          const axes = JSON.parse(r.axisScores) as Record<string, number>;
          for (const [k, v] of Object.entries(axes)) {
            if (!d.axisScores[k]) d.axisScores[k] = [];
            d.axisScores[k].push(v);
          }
        } catch { /* ignore */ }
      }

      const dimensionReports = Array.from(dimMap.entries()).map(([dim, d]) => {
        const avg = Math.round((dimAvgMap2.get(dim) || 0) * 100) / 100;
        const max = d.scores.length > 0 ? Math.max(...d.scores) : 0;
        const min = d.scores.length > 0 ? Math.min(...d.scores) : 0;
        const sorted = [...d.scores].sort((a, b) => a - b);
        const median = sorted.length > 0 ? (sorted.length % 2 === 0 ? Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : sorted[Math.floor(sorted.length / 2)]) : 0;
        const distribution = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
        for (const s of d.scores) {
          if (s <= 20) distribution['0-20']++;
          else if (s <= 40) distribution['21-40']++;
          else if (s <= 60) distribution['41-60']++;
          else if (s <= 80) distribution['61-80']++;
          else distribution['81-100']++;
        }
        const axisAvg: Record<string, number> = {};
        for (const [k, vals] of Object.entries(d.axisScores)) {
          axisAvg[k] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
        }
        return {
          dimension: dim,
          dimensionLabel: dimensionLabelFor(dim, lang),
          count: d.scores.length,
          averageScore: avg, maxScore: max, minScore: min, medianScore: median,
          passRate: d.scores.length > 0 ? Math.round((d.passed / d.scores.length) * 100) : 0,
          passCount: d.passed, failCount: d.failed,
          redLineCount: d.redLine, formatFailCount: d.formatFail,
          distribution, axisAvg,
        };
      }).sort((a, b) => b.averageScore - a.averageScore);

      const allScores = results.map((r) => r.totalScore);
      // 维度加权总分（使用引擎定义的 DIMENSION_WEIGHTS）；单次 run 口径直接用 summary.averageScore
      const totalAvg = (summaryJson2 && typeof summaryJson2.averageScore === 'number')
        ? summaryJson2.averageScore
        : computeWeightedTotal(dimAvgMap2);
      const totalPass = allScores.filter((s) => s >= 60).length;

      const strengths = dimensionReports.filter((d) => d.averageScore >= 75).slice(0, 3);
      const weaknesses = dimensionReports.filter((d) => d.averageScore < 65).slice(-3).reverse();

      // 失败题目（取分数最低的30道）
      const sortedResults = [...results].sort((a, b) => a.totalScore - b.totalScore);
      const failedScenarios = sortedResults
        .filter((r) => r.totalScore < 60)
        .slice(0, 30)
        .map((r) => {
          let evidence: string[] = [];
          let outputMetadata = {};
          try { evidence = JSON.parse(r.evidence || '[]') as string[]; } catch { /* ignore */ }
          try { outputMetadata = JSON.parse(r.outputMetadata || '{}'); } catch { /* ignore */ }
          return {
            scenarioId: r.scenarioId,
            dimension: r.dimension,
            dimensionLabel: dimensionLabelFor(r.dimension, lang),
            totalScore: r.totalScore,
            judgeScore: r.judgeScore,
            evidence,
            outputMetadata,
          };
        });

      // 从 summary 中提取 qualityReport
      let qualityReport;
      try {
        if (run.summary) {
          const summary = JSON.parse(run.summary) as Record<string,unknown>;
          qualityReport = summary.qualityReport;
        }
      } catch { /* ignore */ }

      const reportData: ReportUserPromptData = {
        modelName: run.modelConfig.name,
        modelProvider: run.modelConfig.provider,
        evalConfig: JSON.parse(run.config) as Record<string, unknown>,
        overview: {
          totalScenarios: benchmarkTotal,
          completedScenarios: results.length,
          missingScenarios: Math.max(0, benchmarkTotal - results.length),
          averageScore: totalAvg,
          passRate: results.length > 0 ? Math.round((totalPass / results.length) * 100) : 0,
          passCount: totalPass,
          redLineCount: results.filter((r) => r.safetyLevel === 'red' || r.safetyLevel === 'red_line').length,
          formatFailCount: results.filter((r) => !r.formatParseSuccess).length,
          qualityReport: qualityReport as ReportUserPromptData['overview']['qualityReport'],
        },
        dimensions: dimensionReports,
        failedScenarios,
        radarData: dimensionReports.map((d) => ({ name: d.dimensionLabel, value: d.averageScore })),
        strengths: strengths.map((s) => ({ dimension: s.dimensionLabel, score: s.averageScore, passRate: s.passRate })),
        weaknesses: weaknesses.map((w) => ({ dimension: w.dimensionLabel, score: w.averageScore, passRate: w.passRate })),
      };

      // 调用报告生成
      const reportResult = await generateReport({
        judgeConfig,
        data: reportData,
        onProgress: (stage) => console.log(`[report/generate] ${stage}`),
      });

      // 存储到数据库
      await prisma.evalRun.update({
        where: { id },
        data: { reportContent: reportResult.markdown },
      });

      return {
        success: true,
        data: {
          reportContent: reportResult.markdown,
          metadata: reportResult.metadata,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[report/generate] Error:', msg);
      return reply.status(500).send({ success: false, error: msg });
    }
  });

  // ===== 报告下载 =====
  app.get('/api/runs/:id/report/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { format } = request.query as { format?: string };

    const run = await prisma.evalRun.findUnique({
      where: { id },
      select: { reportContent: true, name: true, modelConfig: { select: { name: true } } },
    });
    if (!run) return reply.status(404).send({ success: false, error: 'Run not found' });
    if (!run.reportContent) {
      return reply.status(404).send({ success: false, error: '请先生成 AI 报告后再下载' });
    }

    const safeName = (run.name || 'report').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');

    if (format === 'md') {
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${safeName}.md"`);
      return reply.send(run.reportContent);
    }

    if (format === 'pdf') {
      const html = markdownToMorandiHtml(run.reportContent, run.modelConfig?.name || '评测模型');
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${safeName}_report.html"`);
      return reply.send(html);
    }

    return reply.status(400).send({ success: false, error: '无效格式，请使用 ?format=md 或 ?format=pdf' });
  });

  // ===== 模型对比报告 =====
  app.post('/api/reports/compare', async (request, reply) => {
    const body = request.body as { runIds?: string[]; modelConfigIds?: string[]; language?: string };
    const lang = body.language === 'en' ? 'en' : 'zh';
    const runIds: string[] = body.runIds || [];
    const modelConfigIds: string[] = body.modelConfigIds || [];

    // 获取 Judge 模型
    const judgeRow = await prisma.modelConfig.findFirst({ where: { modelType: 'judge' } });
    if (!judgeRow) {
      return reply.status(500).send({ success: false, error: '未配置 AI Judge 模型' });
    }

    const judgeConfig: ModelConfig = {
      id: judgeRow.id,
      name: judgeRow.name,
      provider: judgeRow.provider,
      baseUrl: judgeRow.baseUrl,
      apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
      defaultParams: JSON.parse(judgeRow.defaultParams),
      modelType: 'judge',
      reasoningModel: judgeRow.reasoningModel,
    };

    try {
      // 1. 确定要对比的模型
      const modelIds = new Set<string>();

      if (runIds.length > 0) {
        const runs = await prisma.evalRun.findMany({
          where: { id: { in: runIds }, status: 'completed' },
          select: { modelConfigId: true },
        });
        for (const r of runs) modelIds.add(r.modelConfigId);
      }

      if (modelConfigIds.length > 0) {
        for (const mid of modelConfigIds) modelIds.add(mid);
      }

      if (modelIds.size < 2) {
        return reply.status(400).send({ success: false, error: '至少需要2个模型进行对比' });
      }

      // 2. 对每个模型聚合成绩
      const modelData: CompareReportUserPromptData['models'] = [];

      for (const modelConfigId of modelIds) {
        const modelConfig = await prisma.modelConfig.findUnique({ where: { id: modelConfigId } });
        if (!modelConfig) continue;

        const modelRuns = await prisma.evalRun.findMany({
          where: { modelConfigId, status: 'completed' },
          select: { id: true, dimensionFilter: true },
        });
        if (modelRuns.length === 0) continue;

        const allRunIds = modelRuns.map((r) => r.id);
        const benchmarkTotal = await getBenchmarkScopeTotal(modelRuns.map((r) => parseDimensionFilter(r.dimensionFilter)));
        const allResults = await prisma.scenarioResult.findMany({
          where: { evalRunId: { in: allRunIds } },
          select: {
            scenarioId: true, dimension: true, totalScore: true,
            safetyLevel: true, formatParseSuccess: true,
            environmentError: true,
          },
        });

        const dedup = new Map<string, typeof allResults[number]>();
        const isEnvError = (r: { environmentError?: boolean | null }) => r.environmentError === true;
        for (const r of allResults) {
          const existing = dedup.get(r.scenarioId);
          // 优先非环境故障行（重试成功覆盖环境故障；同状态取高分）
          if (!existing
            || (isEnvError(existing) && !isEnvError(r))
            || (!isEnvError(existing) && !isEnvError(r) && r.totalScore > existing.totalScore)) {
            dedup.set(r.scenarioId, r);
          }
        }
        const results = Array.from(dedup.values());

        // 维度聚合
        const dimMap = new Map<string, { scores: number[]; passed: number; failed: number; redLine: number }>();
        for (const r of results) {
          if (r.environmentError === true) continue;  // 环境故障隔离：不进维度分布
          if (!dimMap.has(r.dimension)) {
            dimMap.set(r.dimension, { scores: [], passed: 0, failed: 0, redLine: 0 });
          }
          const d = dimMap.get(r.dimension)!;
          d.scores.push(r.totalScore);
          if (r.totalScore >= 60) d.passed++; else d.failed++;
          if (r.safetyLevel === 'red' || r.safetyLevel === 'red_line') d.redLine++;
        }

        const allScores = results.filter((r) => r.environmentError !== true).map((r) => r.totalScore);
        // 类别加权维度均分 + 维度加权总分（三级计算，与引擎一致）
        const lbDimAvgs = await computeDifficultyWeightedDimAvgs(
          results.map((r) => ({ scenarioId: r.scenarioId, dimension: r.dimension, totalScore: r.totalScore, environmentError: r.environmentError ?? undefined })),
        );
        const totalAvg = computeWeightedTotal(lbDimAvgs);
        const totalPass = allScores.filter((s) => s >= 60).length;

        const dimensions = Array.from(dimMap.entries())
          .map(([dim, d]) => ({
            dimension: dim,
            dimensionLabel: dimensionLabelFor(dim, lang),
            count: d.scores.length,
            averageScore: Math.round((lbDimAvgs.get(dim) || 0) * 100) / 100,
            passRate: d.scores.length > 0 ? Math.round((d.passed / d.scores.length) * 100) : 0,
            passCount: d.passed,
            failCount: d.failed,
            redLineCount: d.redLine,
          }))
          .sort((a, b) => b.averageScore - a.averageScore);

        modelData.push({
          modelName: modelConfig.name,
          modelProvider: modelConfig.provider,
          overview: {
            totalScenarios: benchmarkTotal,
            completedScenarios: results.length,
            missingScenarios: Math.max(0, benchmarkTotal - results.length),
            averageScore: totalAvg,
            passRate: results.length > 0 ? Math.round((totalPass / results.length) * 100) : 0,
            passCount: totalPass,
            redLineCount: results.filter((r) => r.safetyLevel === 'red' || r.safetyLevel === 'red_line').length,
            formatFailCount: results.filter((r) => !r.formatParseSuccess).length,
          },
          dimensions,
        });
      }

      if (modelData.length < 2) {
        return reply.status(400).send({ success: false, error: '可用模型数据不足，至少需要2个有完成评测的模型' });
      }

      // 3. 调用报告生成
      const reportResult = await generateCompareReport({
        judgeConfig,
        data: { models: modelData },
        language: lang,
        onProgress: (stage) => console.log(`[report/compare] ${stage}`),
      });

      return {
        success: true,
        data: {
          reportContent: reportResult.markdown,
          metadata: reportResult.metadata,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[report/compare] Error:', msg);
      return reply.status(500).send({ success: false, error: msg });
    }
  });

  // ===== 模型对比报告下载（MD / HTML 打印版）=====
  app.post('/api/reports/compare/download', async (request, reply) => {
    const body = request.body as { reportContent?: string; modelNames?: string[]; format?: 'md' | 'html' };
    const content = body.reportContent || '';
    const format = body.format === 'html' ? 'html' : 'md';
    const modelNames: string[] = Array.isArray(body.modelNames) ? body.modelNames : [];
    const titleText = modelNames.join(' vs ') || '模型对比';
    const safeName = (modelNames.map((n) => n.replace(/[^a-zA-Z0-9_-]/g, '_')).join('_vs_') || 'model_compare')
      .replace(/_+/g, '_')
      .slice(0, 120);

    if (format === 'md') {
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${safeName}_compare.md"`);
      return reply.send(content);
    }

    const html = markdownToMorandiHtml(content, titleText);
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${safeName}_compare.html"`);
    return reply.send(html);
  });

  // ===== 排行榜 =====
  app.get('/api/leaderboard', async (request) => {
    // scope：latest（默认，单次最新 run 综合分）| best（跨 run 按题取最优，可选）
    const scope = ((request.query as { scope?: string }).scope) === 'best' ? 'best' : 'latest';
    const completedRuns = await prisma.evalRun.findMany({
      where: { status: 'completed' },
      include: { modelConfig: true },
      orderBy: { createdAt: 'desc' },
    });

    // 按 modelConfigId 分组
    const modelGroups = new Map<string, { modelId: string; modelName: string; provider: string; reasoningModel: boolean; maxTokens: number; runIds: string[]; createdAt: Date; dimensionFilters: (string[] | null)[]; latestRunId: string; latestDimensionFilter: string[] | null; latestSummary: { averageScore?: number; dimensionAverages?: Record<string, number>; passCount?: number; safetyRedLineCount?: number; completedScenarios?: number; totalInputTokens?: number; totalOutputTokens?: number } | null }>();

    for (const run of completedRuns) {
      const key = run.modelConfigId;
      if (!modelGroups.has(key)) {
        // 解析最新运行的评测配置（用于披露评测条件可比性）
        let maxTokens = 8192;
        try {
          const cfg = JSON.parse(run.config) as { maxTokens?: number };
          if (typeof cfg.maxTokens === 'number') maxTokens = cfg.maxTokens;
        } catch { /* ignore */ }
        modelGroups.set(key, {
          modelId: key,
          modelName: run.modelConfig.name,
          provider: run.modelConfig.provider,
          reasoningModel: run.modelConfig.reasoningModel,
          maxTokens,
          runIds: [],
          createdAt: run.createdAt,
          dimensionFilters: [],
          latestRunId: run.id,
          latestDimensionFilter: parseDimensionFilter(run.dimensionFilter),
          latestSummary: (() => { try { return run.summary ? JSON.parse(run.summary) : null; } catch { return null; } })(),
        });
      }
      const g = modelGroups.get(key)!;
      g.runIds.push(run.id);
      g.dimensionFilters.push(parseDimensionFilter(run.dimensionFilter));
      // evaluatedAt 取「最新一次」评测时间（completedRuns 已按 createdAt desc 排序，首次即为最新，此处保持最大值）
      if (run.createdAt > g.createdAt) g.createdAt = run.createdAt;
    }

    const leaderboard: Array<{ modelId: string; modelName: string; provider: string; reasoningModel: boolean; maxTokens: number; truncationRate: number; totalScenarios: number; completedScenarios?: number; missingScenarios?: number; averageScore: number; passRate: number; passCount: number; redLineCount: number; dimensionScores: Record<string, unknown>; runCount: number; evaluatedAt: Date; latestRunId: string; totalInputTokens: number; totalOutputTokens: number; totalTokens: number }> = [];
    for (const [modelId, group] of modelGroups) {
      // latest：只统计最新一次 run；best：跨 run 聚合（按题取最优）
      const runIds = scope === 'best' ? group.runIds : [group.latestRunId];
      const benchmarkTotal = await getBenchmarkScopeTotal(
        scope === 'best' ? group.dimensionFilters : [group.latestDimensionFilter],
      );
      const allResults = await prisma.scenarioResult.findMany({
        where: { evalRunId: { in: runIds } },
        select: {
          scenarioId: true, dimension: true, totalScore: true,
          safetyLevel: true, formatParseSuccess: true, outputMetadata: true,
          environmentError: true,
        },
      });

      const dedup = new Map<string, { scenarioId: string; dimension: string; totalScore: number; safetyLevel: string; formatParseSuccess: boolean; environmentError: boolean }>();
      const isEnvError = (r: { environmentError?: boolean | null }) => r.environmentError === true;
      for (const r of allResults) {
        const existing = dedup.get(r.scenarioId);
        // 优先非环境故障行（重试成功覆盖环境故障；同状态取高分）
        if (!existing
          || (isEnvError(existing) && !isEnvError(r))
          || (!isEnvError(existing) && !isEnvError(r) && r.totalScore > existing.totalScore)) {
          dedup.set(r.scenarioId, r);
        }
      }
      const results = Array.from(dedup.values());

      if (results.length === 0) continue;

      const dimMap = new Map<string, { scores: number[]; passed: number; redLine: number }>();
      for (const r of results) {
        if (r.environmentError === true) continue;  // 环境故障隔离：不进维度分布
        if (!dimMap.has(r.dimension)) {
          dimMap.set(r.dimension, { scores: [], passed: 0, redLine: 0 });
        }
        const d = dimMap.get(r.dimension)!;
        d.scores.push(r.totalScore);
        if (r.totalScore >= 60) d.passed++;
        if (r.safetyLevel === 'red' || r.safetyLevel === 'red_line') d.redLine++;
      }

      // 类别加权维度均分（三级计算：类别内平均 → 类别等权维度均分）
      const lbDimAvgs2 = await computeDifficultyWeightedDimAvgs(
        results.map((r) => ({ scenarioId: r.scenarioId, dimension: r.dimension, totalScore: r.totalScore, environmentError: r.environmentError ?? undefined })),
      );
      // latest 口径：维度分直接采用该 run 的 summary.dimensionAverages（与评测历史/实时监控一致，避免重复行去重导致差异）
      if (scope === 'latest' && group.latestSummary?.dimensionAverages) {
        for (const [dim, v] of Object.entries(group.latestSummary.dimensionAverages)) {
          const n = typeof v === 'number' ? v : Number(v);
          if (Number.isFinite(n)) lbDimAvgs2.set(dim, n);
        }
      }

      const dimScores: Record<string, { avg: number; count: number; passRate: number; redLine: number }> = {};
      for (const [dim, d] of dimMap) {
        dimScores[dim] = {
          avg: Math.round((lbDimAvgs2.get(dim) || 0) * 100) / 100,
          count: d.scores.length,
          passRate: d.scores.length > 0 ? Math.round((d.passed / d.scores.length) * 100) : 0,
          redLine: d.redLine,
        };
      }

      const allScores = results.map((r) => r.totalScore);
      // 维度加权总分（使用引擎定义的 DIMENSION_WEIGHTS）；latest 口径直接采用 summary.averageScore
      const totalAvg = (scope === 'latest' && group.latestSummary && typeof group.latestSummary.averageScore === 'number')
        ? group.latestSummary.averageScore
        : computeWeightedTotal(lbDimAvgs2);
      const totalPass = allScores.filter((s) => s >= 60).length;
      const totalRedLine = results.filter((r) => r.safetyLevel === 'red' || r.safetyLevel === 'red_line').length;

      // 截断率 + token 消耗（从 outputMetadata 汇总，比 summary 更鲁棒，旧 run 也适用）
      let truncatedCount = 0;
      let sumInputTokens = 0;
      let sumOutputTokens = 0;
      for (const r of allResults) {
        try {
          const meta = JSON.parse(r.outputMetadata) as { truncated?: boolean; inputTokens?: number; outputTokens?: number };
          if (meta.truncated) truncatedCount++;
          sumInputTokens += meta.inputTokens || 0;
          sumOutputTokens += meta.outputTokens || 0;
        } catch { /* ignore */ }
      }

      leaderboard.push({
        modelId,
        modelName: group.modelName,
        provider: group.provider,
        reasoningModel: group.reasoningModel,
        maxTokens: group.maxTokens,
        truncationRate: allResults.length > 0 ? Math.round((truncatedCount / allResults.length) * 100) : 0,
        totalScenarios: benchmarkTotal,
        completedScenarios: results.length,
        missingScenarios: Math.max(0, benchmarkTotal - results.length),
        averageScore: totalAvg,
        passRate: allScores.length > 0 ? Math.round((totalPass / allScores.length) * 100) : 0,
        passCount: totalPass,
        redLineCount: totalRedLine,
        dimensionScores: dimScores,
        runCount: group.runIds.length,
        evaluatedAt: group.createdAt,
        latestRunId: group.runIds[0],
        totalInputTokens: Math.max(group.latestSummary?.totalInputTokens ?? 0, sumInputTokens),
        totalOutputTokens: Math.max(group.latestSummary?.totalOutputTokens ?? 0, sumOutputTokens),
        totalTokens: (sumInputTokens + sumOutputTokens) || ((group.latestSummary?.totalInputTokens ?? 0) + (group.latestSummary?.totalOutputTokens ?? 0)),
      });
    }

    leaderboard.sort((a, b) => b.averageScore - a.averageScore);

    return { success: true, scope, data: leaderboard };
  });

  /** 单题重试 — 对指定 scenarioId 重新执行评测 */
  app.post('/api/runs/:id/results/:scenarioId/retry', async (request, reply) => {
    const { id: runId, scenarioId } = request.params as { id: string; scenarioId: string };

    // 查找运行记录
    const run = await prisma.evalRun.findUnique({
      where: { id: runId },
      include: { modelConfig: true },
    });
    if (!run) {
      return reply.status(404).send({ success: false, error: 'Run not found' });
    }

    // 查找题目定义
    const scenarioRow = await prisma.scenarioDefinition.findUnique({
      where: { id: scenarioId },
    });
    if (!scenarioRow) {
      return reply.status(404).send({ success: false, error: 'Scenario not found' });
    }

    // 构建模型配置
    const modelConfig: ModelConfig = {
      id: run.modelConfig.id,
      name: run.modelConfig.name,
      provider: run.modelConfig.provider,
      baseUrl: run.modelConfig.baseUrl,
      apiKey: run.modelConfig.apiKey ? decryptApiKey(run.modelConfig.apiKey) : undefined,
      defaultParams: JSON.parse(run.modelConfig.defaultParams),
    };

    const evalConfig: EvalRunConfig = JSON.parse(run.config);

    // 构建 Judge 配置（优先还原 run 创建时固化的 Judge，保证重跑与首跑条件一致）
    let judgeOptions: import('@zxbench/core').JudgeOptions | undefined;
    if (evalConfig.judgeEnabled) {
      const judgeRow = evalConfig.judgeModelConfigId
        ? await prisma.modelConfig.findUnique({ where: { id: evalConfig.judgeModelConfigId } })
        : await prisma.modelConfig.findFirst({ where: { modelType: 'judge' } });
      if (judgeRow) {
        judgeOptions = {
          localModel: {
            id: judgeRow.id,
            name: judgeRow.name,
            provider: judgeRow.provider,
            baseUrl: judgeRow.baseUrl,
            apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
            defaultParams: JSON.parse(judgeRow.defaultParams),
            reasoningModel: judgeRow.reasoningModel,
          },
          escalationThreshold: evalConfig.escalationThreshold || 0.85,
        };
      }
    }

    // 反序列化 scenario
    const scenario = {
      ...scenarioRow,
      tier: ((scenarioRow as Record<string, unknown>).tier || 'public_dev') as ScenarioTier,
      difficulty: scenarioRow.difficulty as 'easy' | 'medium' | 'hard',
      status: scenarioRow.status as 'valid' | 'invalid' | 'ambiguous' | 'needs_context' | 'retired',
      expectedVerdict: (scenarioRow.expectedVerdict ?? undefined) as 'fix' | 'no_bug' | undefined,
      sourceCode: scenarioRow.sourceCode ?? undefined,
      functionName: scenarioRow.functionName ?? undefined,
      outputPolicy: ((scenarioRow as Record<string, unknown>).outputPolicy ?? undefined) as OutputPolicy | undefined,
      scoring: JSON.parse(scenarioRow.scoring),
      hiddenTests: scenarioRow.hiddenTests ? JSON.parse(scenarioRow.hiddenTests) : undefined,
      requirements: scenarioRow.requirements ? JSON.parse(scenarioRow.requirements) : undefined,
      tags: scenarioRow.tags ? JSON.parse(scenarioRow.tags) : undefined,
      // 思考/输出约束字段（反拖尾）：null → undefined 对齐 Scenario 类型
      answerFirst: scenarioRow.answerFirst != null ? scenarioRow.answerFirst : undefined,
      maxAnswerTokens: scenarioRow.maxAnswerTokens != null ? scenarioRow.maxAnswerTokens : undefined,
      maxReasoningTokens: scenarioRow.maxReasoningTokens != null ? scenarioRow.maxReasoningTokens : undefined,
    };

    const questionStartTime = Date.now();

    // 广播：重试开始
    const cached = getLatestProgress(runId);
    if (cached) {
      broadcastProgress({
        ...cached,
        currentScenarioId: scenarioId,
        currentStage: 'initializing' as EvalStage,
      });
    }

    try {
      const result = await orchestrateEvaluation({
        scenario,
        modelConfig,
        modelParams: { ...modelConfig.defaultParams, maxTokens: evalConfig.maxTokens },
        evalConfig,
        judgeOptions,
        onProgress: (stage) => {
          const cached2 = getLatestProgress(runId);
          if (cached2) {
            broadcastProgress({ ...cached2, currentScenarioId: scenarioId, currentStage: stage as EvalStage });
          }
        },
      });

      // 删除旧记录（如果存在）
      await prisma.scenarioResult.deleteMany({
        where: { evalRunId: runId, scenarioId },
      });

      // 写入新记录
      await prisma.scenarioResult.create({
        data: {
          id: generateId(),
          evalRunId: runId,
          scenarioId: result.scenarioId,
          scenarioVersion: result.scenarioVersion,
          dimension: result.dimension,
          modelOutput: result.modelOutput,
          reasoningContent: result.reasoningContent,
          outputMetadata: JSON.stringify(result.outputMetadata),
          formatParseSuccess: result.formatParseSuccess,
          axisScores: JSON.stringify(result.axisScores),
          axisEvidence: result.axisEvidence ? JSON.stringify(result.axisEvidence) : null,
          totalScore: result.totalScore,
          deterministicScore: result.deterministicScore ?? null,
          judgeScore: result.judgeScore ?? null,
          safetyLevel: result.safetyLevel,
          localJudge: result.localJudge ? JSON.stringify(result.localJudge) : null,
          frontierJudge: result.frontierJudge ? JSON.stringify(result.frontierJudge) : null,
          finalJudge: result.finalJudge ? JSON.stringify(result.finalJudge) : null,
          escalated: result.escalated,
          runCount: result.runCount,
          scoreHistory: JSON.stringify(result.scoreHistory),
          verdictHistory: JSON.stringify(result.verdictHistory),
          graderVersion: result.graderVersion,
          evidence: JSON.stringify(result.evidence),
          humanReviewRequired: result.humanReviewRequired,
          reasoningLimitExceeded: result.reasoningLimitExceeded ?? false,
          environmentError: result.environmentError ?? false,
          startedAt: new Date(result.startedAt),
          finishedAt: new Date(result.finishedAt),
        },
      });

      // 修正 worker 的共享实时状态（recentResults + dimMap），防止 worker 下一次广播用旧状态把重试结果覆盖回「失败」
      const liveState = runLiveStates.get(runId);
      if (liveState) {
        const idx = liveState.recentResults.findIndex((r) => r.scenarioId === scenarioId);
        const newIsEnv = result.environmentError === true;
        const liveEntry: QuestionLiveResult = {
          scenarioId: result.scenarioId,
          dimension: result.dimension,
          difficulty: scenario.difficulty,
          language: scenario.language,
          totalScore: result.totalScore,
          safetyLevel: result.safetyLevel as 'safe' | 'red_line',
          passed: result.totalScore >= 60,
          environmentError: newIsEnv,
          durationMs: Date.now() - questionStartTime,
          stage: newIsEnv ? 'environment_error' : 'completed',
          error: newIsEnv ? (result.evidence?.find((e) => e.startsWith('ENVIRONMENT_ERROR:')) ?? '环境/基础设施故障') : undefined,
        };
        if (idx >= 0) {
          const old = liveState.recentResults[idx];
          const dimStats = liveState.dimMap.get(result.dimension);
          if (dimStats) {
            // 旧条目已计数的（非 env_error）→ 撤销 pass/fail/score 计数
            if (old.environmentError !== true && (old.stage === 'failed' || old.passed === false || old.passed === true)) {
              if (old.passed) dimStats.passed = Math.max(0, dimStats.passed - 1);
              else dimStats.failed = Math.max(0, dimStats.failed - 1);
              const si = dimStats.scores.indexOf(old.totalScore);
              if (si >= 0) dimStats.scores.splice(si, 1);
            }
            // 新结果非环境故障 → 正常计数
            if (!newIsEnv) {
              dimStats.scores.push(result.totalScore);
              if (result.totalScore >= 60) dimStats.passed++;
              else dimStats.failed++;
            }
          }
          liveState.recentResults[idx] = liveEntry;
        } else {
          liveState.recentResults.push(liveEntry);
        }
      }

      // 广播：重试完成，替换 recentResults 中对应条目
      const cached3 = getLatestProgress(runId);
      if (cached3) {
        const updatedResults = (cached3.recentResults || []).map((r) =>
          r.scenarioId === scenarioId
            ? {
                ...r,
                totalScore: result.totalScore,
                safetyLevel: result.safetyLevel as 'safe' | 'red_line',
                passed: result.totalScore >= 60,
                durationMs: Date.now() - questionStartTime,
                stage: 'completed' as const,
                error: undefined,
              }
            : r,
        );
        // 如果之前没有该题目的记录（首次重试），添加它
        if (!updatedResults.some((r) => r.scenarioId === scenarioId)) {
          updatedResults.push({
            scenarioId: result.scenarioId,
            dimension: result.dimension,
            difficulty: scenario.difficulty,
            language: scenario.language,
            totalScore: result.totalScore,
            safetyLevel: result.safetyLevel as 'safe' | 'red_line',
            passed: result.totalScore >= 60,
            durationMs: Date.now() - questionStartTime,
            stage: 'completed',
          });
        }
        broadcastProgress({ ...cached3, recentResults: updatedResults });
      }

      // 重新计算「本 run」的总体成绩（用于前端立即更新 KPI）——只取当前 run 的结果，不跨 group 聚合
      const allGroupResults = await prisma.scenarioResult.findMany({
        where: { evalRunId: runId },
      });
      const dedupGroup = new Map<string, { scenarioId: string; score: number; dimension: string; environmentError: boolean }>();
      for (const r of allGroupResults) {
        const existing = dedupGroup.get(r.scenarioId);
        const env = (r as { environmentError?: boolean | null }).environmentError === true;
        if (existing === undefined) {
          dedupGroup.set(r.scenarioId, { scenarioId: r.scenarioId, score: r.totalScore, dimension: (r as { dimension?: string }).dimension || 'unknown', environmentError: env });
        } else if (!env && existing.environmentError) {
          // 非环境故障行覆盖环境故障行
          dedupGroup.set(r.scenarioId, { scenarioId: r.scenarioId, score: r.totalScore, dimension: (r as { dimension?: string }).dimension || 'unknown', environmentError: env });
        } else if (env === existing.environmentError && r.totalScore > existing.score) {
          dedupGroup.set(r.scenarioId, { scenarioId: r.scenarioId, score: r.totalScore, dimension: (r as { dimension?: string }).dimension || 'unknown', environmentError: env });
        }
      }
      const allEntries = Array.from(dedupGroup.values());
      const scores = allEntries.filter((e) => !e.environmentError).map((e) => e.score);
      // 类别加权维度均分 + 维度加权总分（三级计算，与引擎一致）
      const retryDimAvgs = await computeDifficultyWeightedDimAvgs(
        allEntries.map((e) => ({ scenarioId: e.scenarioId, dimension: e.dimension, totalScore: e.score, environmentError: e.environmentError })),
      );
      const groupAvg = computeWeightedTotal(retryDimAvgs);
      const groupPass = scores.filter((s) => s >= 60).length;
      const groupPassRate = scores.length > 0 ? Math.round((groupPass / scores.length) * 100) : 0;

      // 持久化：将重算后的加权均分写回 EvalRun.summary，确保刷新页面后显示正确
      // 注：先读取旧 summary 保留其他字段（qualityReport 等），仅更新 score 和 dimAvgs
      // Map 不能直接 JSON.stringify，需用 Object.fromEntries 转换
      let oldSummary: Record<string, unknown> = {};
      try {
        oldSummary = run.summary ? JSON.parse(run.summary) : {};
      } catch { /* ignore */ }
      await prisma.evalRun.update({
        where: { id: runId },
        data: { summary: JSON.stringify({ ...oldSummary, averageScore: groupAvg, dimensionAverages: Object.fromEntries(retryDimAvgs) }) },
      });

      return {
        success: true,
        data: {
          scenarioId,
          totalScore: result.totalScore,
          passed: result.totalScore >= 60,
          groupStats: {
            totalScenarios: scores.length,
            averageScore: groupAvg,
            passCount: groupPass,
            passRate: groupPassRate,
          },
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // 广播：重试失败
      const cached4 = getLatestProgress(runId);
      if (cached4) {
        const updatedResults = (cached4.recentResults || []).map((r) =>
          r.scenarioId === scenarioId
            ? { ...r, stage: 'failed' as const, error: errMsg, totalScore: 0, passed: false }
            : r,
        );
        broadcastProgress({ ...cached4, recentResults: updatedResults });
      }

      return reply.status(500).send({ success: false, error: errMsg });
    }
  });
}

/** 执行评测（后台）— 支持暂停/继续 + 并行维度测试 */
async function runEvaluation(
  runId: string,
  modelConfigRow: { id: string; name: string; provider: string; baseUrl: string; apiKey: string | null; defaultParams: string },
  config: EvalRunConfig,
  judgeOptions?: import('@zxbench/core').JudgeOptions,
  dimensionFilterOverride?: string[],
): Promise<void> {
  const modelConfig: ModelConfig = {
    id: modelConfigRow.id,
    name: modelConfigRow.name,
    provider: modelConfigRow.provider,
    baseUrl: modelConfigRow.baseUrl,
    apiKey: modelConfigRow.apiKey ? decryptApiKey(modelConfigRow.apiKey) : undefined,
    defaultParams: JSON.parse(modelConfigRow.defaultParams),
  };

  // 确保控制器存在（带 completion promise）
  if (!evalControllers.has(runId)) {
    const ctrl: EvalRunController = { state: 'running', resumePromise: null, resumeResolve: null, completionPromise: null, completionResolve: null };
    ctrl.completionPromise = new Promise<void>((resolve) => { ctrl.completionResolve = resolve; });
    evalControllers.set(runId, ctrl);
  }
  // 挂载配置引用：实时监控 PATCH 修改 maxTokens 时，后续题目立即读到新值
  evalControllers.get(runId)!.config = config;

  await prisma.evalRun.update({ where: { id: runId }, data: { status: 'running' } });

  // 读取维度过滤配置（优先使用 override，用于 fork 场景）
  let dimensionFilter: string[] | null = null;
  if (dimensionFilterOverride && dimensionFilterOverride.length > 0) {
    dimensionFilter = dimensionFilterOverride;
  } else {
    const runRecord = await prisma.evalRun.findUnique({
      where: { id: runId },
      select: { dimensionFilter: true },
    });
    if (runRecord?.dimensionFilter) {
      try { dimensionFilter = JSON.parse(runRecord.dimensionFilter); } catch { /* ignore */ }
    }
  }

  // 加载 valid 题目（可选的维度过滤）
  const scenarioWhere: Record<string, string> = { status: 'valid' };
  const scenarios = await prisma.scenarioDefinition.findMany({
    where: scenarioWhere,
  });
  
  // 应用维度过滤（仅保留指定维度的题目）
  let filteredScenarios = dimensionFilter && dimensionFilter.length > 0
    ? scenarios.filter(s => dimensionFilter!.includes(s.dimension))
    : scenarios;

  // 时效护栏：跳过已过 validUntil 的题目（如时事题参考答案过期），避免过期答案导致误判
  const beforeExpireFilter = filteredScenarios.length;
  filteredScenarios = filteredScenarios.filter((s) => {
    try {
      const req = s.requirements ? JSON.parse(s.requirements) : null;
      if (req?.validUntil && new Date(req.validUntil).getTime() < Date.now()) return false;
      // requiresSandbox 题目：沙箱执行已实现（工作区物化 + 探查转录），恢复参与评测
    } catch { /* requirements 解析失败不阻塞选题 */ }
    return true;
  });
  const skippedExpired = beforeExpireFilter - filteredScenarios.length;
  if (skippedExpired > 0) {
    console.log(`[Eval ${runId}] 跳过 ${skippedExpired} 道已过 validUntil 的时效题`);
  }

  console.log(`[Eval ${runId}] All scenarios: ${scenarios.length}, Filtered: ${filteredScenarios.length}, Dimensions: ${dimensionFilter?.join(', ') || 'all'}`);

  // ===== 恢复机制：查询已完成的题目，跳过 =====
  const existingResults = await prisma.scenarioResult.findMany({
    where: { evalRunId: runId },
    select: { scenarioId: true },
  });
  const completedScenarioIds = new Set(existingResults.map((r) => r.scenarioId));
  const pendingScenarios = filteredScenarios.filter((s) => !completedScenarioIds.has(s.id));
  const total = filteredScenarios.length;
  const alreadyCompleted = total - pendingScenarios.length;

  console.log(`[Eval ${runId}] Total: ${total}, Already completed: ${alreadyCompleted}, Pending: ${pendingScenarios.length}, Parallelism: ${config.parallelism || 4}`);

  // ===== 按维度分组 =====
  const dimensionGroups = new Map<string, typeof scenarios>();
  for (const s of pendingScenarios) {
    const dim = s.dimension;
    if (!dimensionGroups.has(dim)) {
      dimensionGroups.set(dim, []);
    }
    dimensionGroups.get(dim)!.push(s);
  }

  // ===== 初始化维度统计（包含已完成的数据）=====
  const dimMap = new Map<string, { total: number; completed: number; passed: number; failed: number; redLine: number; scores: number[] }>();
  for (const s of filteredScenarios) {
    const dim = s.dimension;
    if (!dimMap.has(dim)) {
      dimMap.set(dim, { total: 0, completed: 0, passed: 0, failed: 0, redLine: 0, scores: [] });
    }
    dimMap.get(dim)!.total++;
  }

  // 恢复已完成题目的统计数据（按 scenarioId 去重，避免重试产生的重复行导致计数虚高）
  const existingFullResults = await prisma.scenarioResult.findMany({
    where: { evalRunId: runId },
    select: { scenarioId: true, dimension: true, totalScore: true, safetyLevel: true, environmentError: true },
  });
  const countedByDim = new Map<string, Set<string>>();
  for (const r of existingFullResults) {
    // 同一 scenarioId 可能因重试产生多行，每个题目只统计一次
    if (!countedByDim.has(r.dimension)) countedByDim.set(r.dimension, new Set());
    const seen = countedByDim.get(r.dimension)!;
    if (seen.has(r.scenarioId)) continue;
    seen.add(r.scenarioId);
    const dimStats = dimMap.get(r.dimension);
    if (dimStats) {
      dimStats.completed++;
      if (r.environmentError === true) continue;  // 环境故障：算完成但不进均值/通过率
      dimStats.scores.push(r.totalScore);
      if (r.safetyLevel === 'red_line') dimStats.redLine++;
      if (r.totalScore >= 60) dimStats.passed++;
      else dimStats.failed++;
    }
  }

  // 统计口径统一为「去重后的已完成题目数」，保证头条数字与维度卡片一致
  function getCompletedCount(): number {
    let c = 0;
    for (const [, s] of dimMap) c += s.completed;
    return c;
  }

  const recentResults: QuestionLiveResult[] = [];
  // 注册共享实时状态：单题重试成功后可直接就地修正，避免 UI 回退
  runLiveStates.set(runId, { recentResults, dimMap });
  const startTime = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const perQuestionSpeeds: number[] = []; // 每题独立速度，用于中位数汇总
  let currentStage: EvalStage = 'queued';
  const activeDimensions = new Set<string>();
  // 并行测试：追踪每个正在处理的题目（key = scenarioId，避免同维度并发覆盖）
  const currentScenariosMap = new Map<string, {
    scenarioId: string;
    dimension: string;
    category?: string;
    difficulty?: string;
    language?: string;
    promptPreview?: string;
    stage: string;
  }>();

  /** 构建完整进度对象并广播 */
  function broadcastFullProgress() {
    const completedCount = getCompletedCount();
    const elapsed = Date.now() - startTime;
    const avgPerQuestion = recentResults.length > 0 ? elapsed / recentResults.length : 0;
    const remaining = total - completedCount;
    const eta = recentResults.length > 0 ? Math.round(avgPerQuestion * remaining) : undefined;

    const dimensionProgress: DimensionProgress[] = [];
    for (const [dim, stats] of dimMap) {
      const avgScore = stats.scores.length > 0
        ? Math.round(stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length)
        : 0;
      dimensionProgress.push({
        dimension: dim,
        total: stats.total,
        completed: stats.completed,
        passed: stats.passed,
        failed: stats.failed,
        redLine: stats.redLine,
        avgScore,
        scores: [...stats.scores],
      });
    }
    dimensionProgress.sort((a, b) => a.dimension.localeCompare(b.dimension));

    const progress: EvalProgress = {
      runId,
      status: 'running',
      total,
      completed: completedCount,
      percentage: total > 0 ? Math.round((completedCount / total) * 100) : 0,
      eta,
      tokensPerSecond: perQuestionSpeeds.length > 0
        ? Math.round(perQuestionSpeeds.sort((a, b) => a - b)[Math.floor(perQuestionSpeeds.length / 2)])
        : undefined,
      totalTokens: totalInputTokens + totalOutputTokens,
      currentStage: 'running' as EvalStage,
      dimensionProgress,
      activeDimensions: [...activeDimensions],
      currentScenarios: Object.fromEntries(currentScenariosMap),
      recentResults: [...recentResults].reverse().slice(0, 50),
      // 并发模式下不再尝试推断"当前题目"（由单题广播设置）
    };

    broadcastProgress(progress);
  }

  // 广播初始状态
  broadcastFullProgress();

  // ===== 并行模式选择 =====
  const parallelMode = config.parallelMode || 'global';
  const concurrency = Math.min(Math.min(config.parallelism || 4, 4), pendingScenarios.length);
  console.log(`[Eval ${runId}] Parallel mode: ${parallelMode}, Concurrency: ${concurrency}`);

  // 构建题目队列：统一扁平行列，两种模式仅排列顺序不同
  // global 模式：轮转交叉（dim1-q1, dim2-q1, ..., dim1-q2, ...）→ 各维度公平推进
  // per_dimension 模式：按维度分组（dim1 全题, dim2 全题, ...）→ 同维度集中推进
  const allPendingQuestions: { scenarioRow: typeof scenarios[number]; dimension: string }[] = [];
  if (parallelMode === 'per_dimension') {
    for (const [dim, dimScenarios] of dimensionGroups) {
      for (const s of dimScenarios) {
        allPendingQuestions.push({ scenarioRow: s, dimension: dim });
      }
    }
  } else {
    const dimArrays = [...dimensionGroups.entries()].map(([dim, dimScenarios]) => ({
      dim,
      scenarios: dimScenarios,
      index: 0,
    }));
    let remaining = pendingScenarios.length;
    while (remaining > 0) {
      for (const entry of dimArrays) {
        if (entry.index < entry.scenarios.length) {
          allPendingQuestions.push({ scenarioRow: entry.scenarios[entry.index], dimension: entry.dim });
          entry.index++;
          remaining--;
        }
      }
    }
  }

  let questionQueueIndex = 0;
  const dimensionActiveCount = new Map<string, number>();

  // 确保并发数不超过题目总数（避免空转）
  const actualConcurrency = Math.min(concurrency, allPendingQuestions.length);
  console.log(`[Eval ${runId}] Queue built: ${allPendingQuestions.length} questions, ${actualConcurrency} workers (${parallelMode} mode)`);

  /** 处理单个题目（从全局队列中取出） */
  async function processQuestion(scenarioRow: typeof scenarios[number], dimension: string): Promise<void> {
    // 标记维度活跃
    const cnt = dimensionActiveCount.get(dimension) || 0;
    dimensionActiveCount.set(dimension, cnt + 1);
    activeDimensions.add(dimension);

    // 记录当前维度正在处理的题目信息（用 scenarioId 作键，避免同维度多题并发覆盖）
    const trackingKey = scenarioRow.id;
    currentScenariosMap.set(trackingKey, {
      scenarioId: scenarioRow.id,
      dimension: dimension,
      category: scenarioRow.category ?? undefined,
      difficulty: scenarioRow.difficulty ?? undefined,
      language: scenarioRow.language ?? undefined,
      promptPreview: scenarioRow.promptTemplate.slice(0, 200),
      stage: 'initializing',
    });

    const scenario = {
      ...scenarioRow,
      tier: ((scenarioRow as Record<string, unknown>).tier || 'public_dev') as ScenarioTier,
      difficulty: scenarioRow.difficulty as 'easy' | 'medium' | 'hard',
      status: scenarioRow.status as 'valid' | 'invalid' | 'ambiguous' | 'needs_context' | 'retired',
      expectedVerdict: (scenarioRow.expectedVerdict ?? undefined) as 'fix' | 'no_bug' | undefined,
      sourceCode: scenarioRow.sourceCode ?? undefined,
      functionName: scenarioRow.functionName ?? undefined,
      outputPolicy: ((scenarioRow as Record<string, unknown>).outputPolicy ?? undefined) as OutputPolicy | undefined,
      scoring: JSON.parse(scenarioRow.scoring),
      hiddenTests: scenarioRow.hiddenTests ? JSON.parse(scenarioRow.hiddenTests) : undefined,
      requirements: scenarioRow.requirements ? JSON.parse(scenarioRow.requirements) : undefined,
      tags: scenarioRow.tags ? JSON.parse(scenarioRow.tags) : undefined,
      // 思考/输出约束字段（反拖尾）：null → undefined 对齐 Scenario 类型
      answerFirst: scenarioRow.answerFirst != null ? scenarioRow.answerFirst : undefined,
      maxAnswerTokens: scenarioRow.maxAnswerTokens != null ? scenarioRow.maxAnswerTokens : undefined,
      maxReasoningTokens: scenarioRow.maxReasoningTokens != null ? scenarioRow.maxReasoningTokens : undefined,
    };

    const questionStartTime = Date.now();

    // 广播：开始测试新题目
    broadcastProgress({
      runId,
      status: 'running',
      total,
      completed: getCompletedCount(),
      percentage: total > 0 ? Math.round((getCompletedCount() / total) * 100) : 0,
      currentScenarioId: scenario.id,
      currentDimension: scenario.dimension,
      currentCategory: scenario.category,
      currentDifficulty: scenario.difficulty,
      currentLanguage: scenario.language,
      currentPromptPreview: scenario.promptTemplate.slice(0, 200),
      currentStage: 'initializing' as EvalStage,
      dimensionProgress: getDimProgressSnapshot(dimMap),
      activeDimensions: [...activeDimensions],
      recentResults: [...recentResults].reverse().slice(0, 50),
      current: scenario.id,
      currentScenarios: Object.fromEntries(currentScenariosMap),
    });

    try {
      const result = await orchestrateEvaluation({
        scenario,
        modelConfig,
        modelParams: { ...modelConfig.defaultParams, maxTokens: config.maxTokens },
        evalConfig: config,
        judgeOptions,
        constraints: config.constraints, // 思考/输出约束（反拖尾）
        onProgress: (stage) => {
          // 同步更新当前题目的阶段
          const entry = currentScenariosMap.get(trackingKey);
          if (entry) entry.stage = stage;

          broadcastProgress({
            runId,
            status: 'running',
            total,
            completed: recentResults.length + alreadyCompleted,
            percentage: total > 0 ? Math.round(((recentResults.length + alreadyCompleted) / total) * 100) : 0,
            currentScenarioId: scenario.id,
            currentDimension: scenario.dimension,
            currentCategory: scenario.category,
            currentDifficulty: scenario.difficulty,
            currentLanguage: scenario.language,
            currentPromptPreview: scenario.promptTemplate.slice(0, 200),
            currentStage: stage as EvalStage,
            dimensionProgress: getDimProgressSnapshot(dimMap),
            activeDimensions: [...activeDimensions],
            recentResults: [...recentResults].reverse().slice(0, 50),
            current: scenario.id,
            currentScenarios: Object.fromEntries(currentScenariosMap),
          });
        },
      });

      await prisma.scenarioResult.create({
        data: {
          id: generateId(),
          evalRunId: runId,
          scenarioId: result.scenarioId,
          scenarioVersion: result.scenarioVersion,
          dimension: result.dimension,
          modelOutput: result.modelOutput,
          reasoningContent: result.reasoningContent,
          outputMetadata: JSON.stringify(result.outputMetadata),
          formatParseSuccess: result.formatParseSuccess,
          axisScores: JSON.stringify(result.axisScores),
          axisEvidence: result.axisEvidence ? JSON.stringify(result.axisEvidence) : null,
          totalScore: result.totalScore,
          deterministicScore: result.deterministicScore ?? null,
          judgeScore: result.judgeScore ?? null,
          safetyLevel: result.safetyLevel,
          localJudge: result.localJudge ? JSON.stringify(result.localJudge) : null,
          frontierJudge: result.frontierJudge ? JSON.stringify(result.frontierJudge) : null,
          finalJudge: result.finalJudge ? JSON.stringify(result.finalJudge) : null,
          escalated: result.escalated,
          runCount: result.runCount,
          scoreHistory: JSON.stringify(result.scoreHistory),
          verdictHistory: JSON.stringify(result.verdictHistory),
          graderVersion: result.graderVersion,
          evidence: JSON.stringify(result.evidence),
          humanReviewRequired: result.humanReviewRequired,
          environmentError: result.environmentError ?? false,
          startedAt: new Date(result.startedAt),
          finishedAt: new Date(result.finishedAt),
        },
      });

      // 累加 token 用量（用于计算 token 速度）
      totalInputTokens += result.outputMetadata.inputTokens || 0;
      totalOutputTokens += result.outputMetadata.outputTokens || 0;
      // 每题独立速度（优先预计算 tokenSpeed，其次原生，最后推断）
      const qSpeed = result.outputMetadata.tokenSpeed
        || result.outputMetadata.nativeTokensPerSecond
        || (result.outputMetadata.inferenceMs && result.outputMetadata.outputTokens
          ? Math.round(result.outputMetadata.outputTokens / (result.outputMetadata.inferenceMs / 1000))
          : 0);
      if (qSpeed > 0) perQuestionSpeeds.push(qSpeed);

      // 更新维度统计
      const dimStats = dimMap.get(scenario.dimension);
      if (dimStats) {
        dimStats.completed++;
        // 环境故障隔离：算完成但不进均值/通过率（不污染模型分数）
        if (result.environmentError !== true) {
          dimStats.scores.push(result.totalScore);
          if (result.safetyLevel === 'red_line') dimStats.redLine++;
          if (result.totalScore >= 60) dimStats.passed++;
          else dimStats.failed++;
        }
      }

      const isReasoningLimit = result.reasoningLimitExceeded === true;
      recentResults.push({
        scenarioId: result.scenarioId,
        dimension: result.dimension,
        difficulty: scenario.difficulty,
        language: scenario.language,
        totalScore: result.totalScore,
        safetyLevel: result.safetyLevel as 'safe' | 'red_line',
        passed: result.totalScore >= 60,
        environmentError: result.environmentError === true,
        durationMs: Date.now() - questionStartTime,
        stage: isReasoningLimit ? 'reasoning_limit' : (result.environmentError === true ? 'environment_error' : 'completed'),
        error: isReasoningLimit ? (result.evidence?.[0] ?? '思考/输出超限')
          : (result.environmentError === true ? (result.evidence?.find((e) => e.startsWith('ENVIRONMENT_ERROR:')) ?? '环境/基础设施故障') : undefined),
        outputTokens: result.outputMetadata?.outputTokens,
        inputTokens: result.outputMetadata?.inputTokens,
        inferenceMs: result.outputMetadata?.inferenceMs,
        nativeTokensPerSecond: result.outputMetadata?.nativeTokensPerSecond,
        tokenSpeed: result.outputMetadata?.tokenSpeed,
      });
    } catch (err) {
      console.error(`Scenario ${scenario.id} failed:`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      // ===== 兜底：硬性配额/鉴权错误（余额不足、401/403 等）→ 暂停评测，避免烧 token =====
      // 不落 0 分：该题保持「未完成」，resume 后会自动重跑；其余 worker 会在 checkPause 处等待。
      if (isHardQuotaError(errMsg)) {
        console.error(`[Eval ${runId}] 硬性错误，暂停评测（避免烧 token）: ${errMsg}`);
        pauseEvaluation(runId);
        await prisma.evalRun.update({ where: { id: runId }, data: { status: 'paused' } }).catch(() => {});
        const dimCnt = (dimensionActiveCount.get(dimension) || 1) - 1;
        dimensionActiveCount.set(dimension, dimCnt);
        if (dimCnt <= 0) activeDimensions.delete(dimension);
        currentScenariosMap.delete(trackingKey);
        broadcastProgress({
          runId,
          status: 'paused',
          total,
          completed: getCompletedCount(),
          percentage: total > 0 ? Math.round((getCompletedCount() / total) * 100) : 0,
          currentStage: 'paused' as EvalStage,
          dimensionProgress: getDimProgressSnapshot(dimMap),
          activeDimensions: [...activeDimensions],
          recentResults: [...recentResults].reverse().slice(0, 50),
          currentScenarios: Object.fromEntries(currentScenariosMap),
        });
        return;
      }
      // 容错：若生成已成功但后续阶段抛错，保留已生成的模型输出（可后续重新判分，无需重跑生成）
      const partialOutput = (err as { partialModelOutput?: string })?.partialModelOutput ?? '';
      const partialReasoning = (err as { partialReasoningContent?: string })?.partialReasoningContent;

      // 评测失败也落库（记 0 分 + 错误证据），保证 run 覆盖全部题目，
      // 而非静默丢弃导致"缺失 N 题"。标记为需人工复核。
      try {
        await prisma.scenarioResult.create({
          data: {
            id: generateId(),
            evalRunId: runId,
            scenarioId: scenario.id,
            scenarioVersion: String(scenario.scenarioVersion || '1.0.0'),
            dimension: scenario.dimension,
            modelOutput: partialOutput,
            reasoningContent: partialReasoning ?? null,
            outputMetadata: JSON.stringify({ error: errMsg, hadPartialOutput: partialOutput.length > 0 }),
            formatParseSuccess: false,
            axisScores: JSON.stringify({}),
            axisEvidence: null,
            totalScore: 0,
            safetyLevel: 'safe',
            runCount: 1,
            scoreHistory: JSON.stringify([0]),
            verdictHistory: JSON.stringify(['error']),
            graderVersion: 'n/a',
            evidence: JSON.stringify([`Evaluation failed: ${errMsg}`]),
            humanReviewRequired: true,
            startedAt: new Date(questionStartTime),
            finishedAt: new Date(),
          },
        });
      } catch (writeErr) {
        console.error(`Failed to persist error result for ${scenario.id}:`, writeErr);
      }

      const dimStats = dimMap.get(scenario.dimension);
      if (dimStats) {
        dimStats.completed++;
        dimStats.failed++;
      }

      recentResults.push({
        scenarioId: scenario.id,
        dimension: scenario.dimension,
        difficulty: scenario.difficulty,
        language: scenario.language,
        totalScore: 0,
        safetyLevel: 'safe',
        passed: false,
        durationMs: Date.now() - questionStartTime,
        stage: 'failed',
        error: errMsg,
      });
    }

    // 广播：本题完成
    broadcastFullProgress();

    // 标记维度不活跃（如果没有更多题目在处理）
    const newCnt = (dimensionActiveCount.get(dimension) || 1) - 1;
    dimensionActiveCount.set(dimension, newCnt);
    if (newCnt <= 0) {
      activeDimensions.delete(dimension);
    }
    // 始终清除当前题目的跟踪信息
    currentScenariosMap.delete(trackingKey);
  }

  // 全局并发 worker 池：统一使用原子计数器从共享队列取题
  // 4 worker = 最多 4 题并发 = 最多 4 维度并发（自动满足）
  async function runGlobalWorker(): Promise<void> {
    while (true) {
      const checkResult = await checkPause(runId);
      if (checkResult === 'cancelled') return;

      const idx = questionQueueIndex++;
      if (idx >= allPendingQuestions.length) break;
      const { scenarioRow, dimension } = allPendingQuestions[idx];
      await processQuestion(scenarioRow, dimension);
    }
  }

  // 启动 worker：严格按并发数创建
  const allWorkers: Promise<void>[] = [];
  for (let i = 0; i < actualConcurrency; i++) {
    allWorkers.push(runGlobalWorker());
  }

  await Promise.all(allWorkers);

  // 清理控制器
  const ctrl = evalControllers.get(runId);
  if (ctrl && ctrl.state === 'cancelled') {
    if (ctrl.restartRequested) {
      // Fork 重启：不标记为 cancelled，仅清理控制器，让 fork 端点启动新的评测
      evalControllers.delete(runId);
      if (ctrl.completionResolve) ctrl.completionResolve();
      return;
    }
    await prisma.evalRun.update({ where: { id: runId }, data: { status: 'cancelled' } });
    evalControllers.delete(runId);
    runLiveStates.delete(runId);
    if (ctrl.completionResolve) ctrl.completionResolve();
    return;
  }
  evalControllers.delete(runId);
  runLiveStates.delete(runId);

  // 如果是 restartRequested 导致的自然结束（非 cancelled），也需要通知 fork 端点
  // 注意：走到这里说明所有 worker 自然结束（队列耗尽），不是被 cancel 的

  // 计算类别加权维度均分摘要（三级计算：类别内平均 → 类别等权维度均分 → 维度加权总分）
  // 环境故障行（environmentError）由 computeDifficultyWeightedDimAvgs 内部隔离，不计入均值
  const results = await prisma.scenarioResult.findMany({ where: { evalRunId: runId } });
  const summaryDimAvgs = await computeDifficultyWeightedDimAvgs(
    results.map((r) => ({ scenarioId: r.scenarioId, dimension: (r as { dimension?: string }).dimension || 'unknown', totalScore: r.totalScore, environmentError: (r as { environmentError?: boolean | null }).environmentError ?? undefined })),
  );
  const avgScore = computeWeightedTotal(summaryDimAvgs);

  // ===== 运行质量自动诊断 =====
  const qualityReport = await buildRunQualityReport(runId, results as Array<{ totalScore: number; judgeScore: number | null; modelOutput: string | null; outputMetadata: string | null; deterministicScore: number | null }>, total);

  const finishedAt = Date.now();
  const durationMs = finishedAt - startTime;
  // 计算每题独立 token 速度中位数
  const perQuestionSpeeds2: number[] = [];
  let summaryInputTokens = 0;
  let summaryOutputTokens = 0;
  for (const r of results) {
    try {
      const meta = r.outputMetadata ? JSON.parse(r.outputMetadata) : null;
      if (meta) {
        summaryInputTokens += meta.inputTokens || 0;
        summaryOutputTokens += meta.outputTokens || 0;
        const speed = meta.tokenSpeed
          || meta.nativeTokensPerSecond
          || (meta.inferenceMs && meta.outputTokens ? Math.round(meta.outputTokens / (meta.inferenceMs / 1000)) : 0);
        if (speed > 0) perQuestionSpeeds2.push(speed);
      }
    } catch { /* ignore */ }
  }
  const sorted2 = perQuestionSpeeds2.sort((a, b) => a - b);
  const avgTokensPerSecond = perQuestionSpeeds2.length > 0
    ? Math.round(sorted2[Math.floor(sorted2.length / 2)])
    : 0;
  // 去重后的通过题数（避免重试重复行虚高；环境故障行不计）
  const passSeen = new Set<string>();
  let passCount = 0;
  for (const r of results) {
    if (passSeen.has(r.scenarioId)) continue;
    passSeen.add(r.scenarioId);
    if ((r as { environmentError?: boolean | null }).environmentError === true) continue;
    if (r.totalScore >= 60) passCount++;
  }
  await prisma.evalRun.update({
    where: { id: runId },
    data: {
      status: 'completed',
      summary: JSON.stringify({
        totalScenarios: total,
        completedScenarios: results.length,
        averageScore: avgScore,
        passCount,
        dimensionAverages: Object.fromEntries(summaryDimAvgs),
        safetyRedLineCount: results.filter((r) => r.safetyLevel === 'red_line').length,
        totalInputTokens: summaryInputTokens,
        totalOutputTokens: summaryOutputTokens,
        avgTokensPerSecond,
        qualityReport,
        // ===== 耗时（多模型并行汇总用）=====
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs,
      }),
    },
  });

  // 广播：评测完成
  currentStage = 'completed';
  broadcastProgress({
    runId,
    status: 'completed',
    total,
    completed: total,
    percentage: 100,
    currentStage: 'completed',
    dimensionProgress: getDimProgressSnapshot(dimMap),
    activeDimensions: [],
    recentResults: [...recentResults].reverse().slice(0, 50),
    current: undefined,
  });

  // 通知 completion promise（用于 fork 等待）
  const finCtrl = evalControllers.get(runId);
  if (finCtrl?.completionResolve) {
    finCtrl.completionResolve();
  }
}

/** 运行质量自动诊断 — 在 run 完成时调用，检测常见异常 */
interface QualityReport {
  grade: 'good' | 'warning' | 'critical';
  issues: string[];
  emptyOutputCount: number;
  judgeZeroCount: number;
  lengthFinishCount: number;
  zeroDeterministCount: number;
}

async function buildRunQualityReport(
  runId: string,
  results: Array<{ totalScore: number; judgeScore: number | null; modelOutput: string | null; outputMetadata: string | null; deterministicScore: number | null }>,
  totalScenarios: number,
): Promise<QualityReport> {
  const issues: string[] = [];
  const threshold = Math.max(5, Math.floor(totalScenarios * 0.05)); // 至少 5 道，或 5%

  // 检查空输出
  const emptyOutputs = results.filter((r) => !r.modelOutput || r.modelOutput.trim().length === 0);
  if (emptyOutputs.length > 0) {
    issues.push(`空输出: ${emptyOutputs.length}/${totalScenarios} 题 (${(emptyOutputs.length / totalScenarios * 100).toFixed(1)}%)`);
  }

  // 检查 Judge 得 0 分
  const judgeZero = results.filter((r) => r.judgeScore === 0);
  const judgeScored = results.filter((r) => r.judgeScore !== null);
  if (judgeScored.length > 0 && judgeZero.length > 0) {
    const pct = (judgeZero.length / judgeScored.length * 100).toFixed(1);
    issues.push(`Judge 0 分: ${judgeZero.length}/${judgeScored.length} 题 (${pct}%)`);
  }

  // 检查 finish_reason=length (输出截断)
  const lengthFinishScenarios: string[] = [];
  for (const r of results) {
    if (!r.outputMetadata) continue;
    try {
      const meta = JSON.parse(r.outputMetadata);
      if (meta?.finishReason === 'length') {
        lengthFinishScenarios.push(meta?.scenarioId || '?');
      }
    } catch { /* ignore */ }
  }
  if (lengthFinishScenarios.length > 0) {
    issues.push(`输出截断(finish_reason=length): ${lengthFinishScenarios.length} 题 — ${lengthFinishScenarios.slice(0, 10).join(', ')}${lengthFinishScenarios.length > 10 ? '...' : ''}`);
  }

  // 检查确定性评分为 0（可能评分器未注册）
  const zeroDet = results.filter((r) => r.deterministicScore === 0 && r.judgeScore === null);
  if (zeroDet.length > 0) {
    issues.push(`确定性评分为 0(Judge 未参与): ${zeroDet.length} 题`);
  }

  // 判定等级
  let grade: QualityReport['grade'] = 'good';
  if (emptyOutputs.length > threshold || lengthFinishScenarios.length > threshold) {
    grade = 'critical';
  } else if (emptyOutputs.length > 0 || judgeZero.length > threshold || lengthFinishScenarios.length > 0) {
    grade = 'warning';
  }

  console.log(`[QualityReport] Run ${runId.slice(-12)}: grade=${grade}, issues=${issues.length}, empty=${emptyOutputs.length}, judge0=${judgeZero.length}, length=${lengthFinishScenarios.length}`);

  return {
    grade,
    issues,
    emptyOutputCount: emptyOutputs.length,
    judgeZeroCount: judgeZero.length,
    lengthFinishCount: lengthFinishScenarios.length,
    zeroDeterministCount: zeroDet.length,
  };
}

/** 获取各维度进度的快照 */
function getDimProgressSnapshot(dimMap: Map<string, { total: number; completed: number; passed: number; failed: number; redLine: number; scores: number[] }>): DimensionProgress[] {
  const result: DimensionProgress[] = [];
  for (const [dim, stats] of dimMap) {
    const avgScore = stats.scores.length > 0
      ? Math.round(stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length)
      : 0;
    result.push({
      dimension: dim,
      total: stats.total,
      completed: stats.completed,
      passed: stats.passed,
      failed: stats.failed,
      redLine: stats.redLine,
      avgScore,
      scores: [...stats.scores],
    });
  }
  return result.sort((a, b) => a.dimension.localeCompare(b.dimension));
}

// ===== 反序列化辅助 =====

function deserializeModel(row: { id: string; name: string; provider: string; baseUrl: string; apiKey: string | null; defaultParams: string; modelType: string; reasoningModel: boolean; displayName: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    ...row,
    apiKey: row.apiKey ? decryptApiKey(row.apiKey) : null,
    defaultParams: JSON.parse(row.defaultParams),
    reasoningModel: row.reasoningModel,
  };
}

/** 反序列化模型配置（脱敏版：API 返回用） */
function deserializeModelMasked(row: { id: string; name: string; provider: string; baseUrl: string; apiKey: string | null; defaultParams: string; modelType: string; reasoningModel: boolean; displayName: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    ...row,
    apiKey: maskApiKey(row.apiKey ? decryptApiKey(row.apiKey) : null),
    defaultParams: JSON.parse(row.defaultParams),
    reasoningModel: row.reasoningModel,
  };
}

function deserializeResult(row: {
  id: string; evalRunId: string; scenarioId: string; scenarioVersion: string; dimension: string;
  modelOutput: string; reasoningContent: string | null; outputMetadata: string;
  formatParseSuccess: boolean; axisScores: string; axisEvidence: string | null; totalScore: number; safetyLevel: string;
  localJudge: string | null; frontierJudge: string | null; finalJudge: string | null;
  escalated: boolean; runCount: number; scoreHistory: string; verdictHistory: string;
  graderVersion: string; evidence: string; humanReviewRequired: boolean;
  reasoningLimitExceeded: boolean;
  startedAt: Date; finishedAt: Date;
}) {
  return {
    ...row,
    outputMetadata: JSON.parse(row.outputMetadata),
    axisScores: JSON.parse(row.axisScores),
    axisEvidence: row.axisEvidence ? JSON.parse(row.axisEvidence) : undefined,
    localJudge: row.localJudge ? JSON.parse(row.localJudge) : null,
    frontierJudge: row.frontierJudge ? JSON.parse(row.frontierJudge) : null,
    finalJudge: row.finalJudge ? JSON.parse(row.finalJudge) : null,
    scoreHistory: JSON.parse(row.scoreHistory),
    verdictHistory: JSON.parse(row.verdictHistory),
    evidence: JSON.parse(row.evidence),
  };
}

// ===== GPT5.6 P0-3: SSRF 防护 =====

/** 禁止访问的内网地址 */
const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '::1', '0.0.0.0',
  '169.254.169.254', // AWS/GCP metadata
  '169.254.169.253',
  'metadata.google.internal',
];

/** 禁止的内网 IP 范围 */
const BLOCKED_IP_RANGES = [
  /^10\./,           // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,  // RFC1918
  /^192\.168\./,     // RFC1918
  /^127\./,          // Loopback
  /^169\.254\./,     // Link-local
  /^0\./,            // Current network
  /^::1/, /^fe80:/i, // IPv6 loopback/link-local
  /^fc00:/i,         // IPv6 unique local
];

/** 验证 URL 安全性（防止 SSRF） */
async function validateUrlSafety(url: string): Promise<{ safe: boolean; reason?: string }> {
  try {
    const parsed = new URL(url);

    // 仅允许 HTTP/HTTPS
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { safe: false, reason: `禁止的协议: ${parsed.protocol}` };
    }

    // 检查主机名
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
      return { safe: false, reason: `禁止访问内网地址: ${hostname}` };
    }

    // DNS 解析后检查 IP
    try {
      const addresses = await dnsLookup(hostname, { all: true });
      for (const addr of (Array.isArray(addresses) ? addresses : [addresses])) {
        const ip = addr.address || String(addr);
        for (const range of BLOCKED_IP_RANGES) {
          if (range.test(ip)) {
            return { safe: false, reason: `DNS 解析到内网 IP: ${ip}` };
          }
        }
      }
    } catch {
      // DNS 解析失败也允许（可能是本地开发环境）
    }

    // 重定向次数限制（通过 fetch 的 redirect: 'follow' 默认行为）
    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `无效 URL: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ===== GPT5.6 P0-3: 路径穿越防护 =====

/** 检查目录中是否存在路径穿越文件 */
function checkPathTraversal(rootDir: string): string | null {
  const resolvedRoot = path.resolve(rootDir);

  function checkDir(dir: string): string | null {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const resolved = path.resolve(fullPath);
        if (!resolved.startsWith(resolvedRoot)) {
          return `路径穿越: ${fullPath} 超出根目录`;
        }
        if (entry.isDirectory()) {
          const sub = checkDir(fullPath);
          if (sub) return sub;
        }
      }
    } catch { /* ignore permission errors */ }
    return null;
  }

  return checkDir(rootDir);
}

/** 检查目录中是否存在符号链接 */
function checkSymlinks(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        return `符号链接: ${fullPath}`;
      }
      if (entry.isDirectory()) {
        const sub = checkSymlinks(fullPath);
        if (sub) return sub;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** 获取目录统计信息 */
function getDirectoryStats(dir: string): { fileCount: number; totalSize: number } {
  let fileCount = 0;
  let totalSize = 0;

  function walk(d: string) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(d, entry.name);
        if (entry.isFile()) {
          fileCount++;
          try { totalSize += fs.statSync(fullPath).size; } catch { /* ignore */ }
        } else if (entry.isDirectory()) {
          walk(fullPath);
        }
      }
    } catch { /* ignore */ }
  }

  walk(dir);
  return { fileCount, totalSize };
}

// ===== GPT5.6 P0-2: 从静态 JSON 加载题目数据 =====

/**
 * 从题包目录中加载题目数据（纯静态，不执行任何 JS）
 * 支持以下数据源：
 * 1. scenarios.json / scenarios/*.json
 * 2. data/scenarios/*.json
 * 3. zxbench.pack.json 中的 scenarios 字段
 */
async function loadScenariosFromStaticData(packRoot: string): Promise<Array<Record<string, unknown>>> {
  const allScenarios: Array<Record<string, unknown>> = [];

  // 尝试 1: scenarios.json
  const scenariosJsonPath = path.join(packRoot, 'scenarios.json');
  if (fs.existsSync(scenariosJsonPath)) {
    try {
      const data = JSON.parse(await fsp.readFile(scenariosJsonPath, 'utf8'));
      if (Array.isArray(data)) {
        allScenarios.push(...data.map((s) => s as Record<string, unknown>));
      }
    } catch (err) {
      console.error('Failed to parse scenarios.json:', err);
    }
  }

  // 尝试 2: scenarios/*.json
  const scenariosDir = path.join(packRoot, 'scenarios');
  if (fs.existsSync(scenariosDir) && fs.statSync(scenariosDir).isDirectory()) {
    try {
      const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(await fsp.readFile(path.join(scenariosDir, file), 'utf8'));
          if (Array.isArray(data)) {
            allScenarios.push(...data.map((s) => s as Record<string, unknown>));
          } else if (data && typeof data === 'object') {
            allScenarios.push(data as Record<string, unknown>);
          }
        } catch (err) {
          console.error(`Failed to parse ${file}:`, err);
        }
      }
    } catch { /* ignore */ }
  }

  // 尝试 3: data/scenarios/*.json
  const dataScenariosDir = path.join(packRoot, 'data', 'scenarios');
  if (fs.existsSync(dataScenariosDir) && fs.statSync(dataScenariosDir).isDirectory()) {
    try {
      const files = fs.readdirSync(dataScenariosDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(await fsp.readFile(path.join(dataScenariosDir, file), 'utf8'));
          if (Array.isArray(data)) {
            allScenarios.push(...data.map((s) => s as Record<string, unknown>));
          }
        } catch (err) {
          console.error(`Failed to parse data/scenarios/${file}:`, err);
        }
      }
    } catch { /* ignore */ }
  }

  // 尝试 4: zxbench.pack.json 中的 scenarios 字段
  const packJsonPath = path.join(packRoot, 'zxbench.pack.json');
  if (fs.existsSync(packJsonPath) && allScenarios.length === 0) {
    try {
      const packMeta = JSON.parse(await fsp.readFile(packJsonPath, 'utf8'));
      if (Array.isArray(packMeta.scenarios)) {
        allScenarios.push(...packMeta.scenarios.map((s: Record<string, unknown>) => s));
      }
    } catch { /* ignore */ }
  }

  return allScenarios;
}

// ===== GPT5.6 P0-7: 导出脱敏 =====

/** 敏感数据模式（用于导出时脱敏） */
const SENSITIVE_PATTERNS = [
  // API Key / Token
  { pattern: /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[:=]\s*['"]([^'"]{8,})['"]/gi, replacement: '$1: [REDACTED]' },
  // Bearer Token
  { pattern: /Bearer\s+([A-Za-z0-9_\-.]{20,})/gi, replacement: 'Bearer [REDACTED]' },
  // Email-like PII
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL_REDACTED]' },
  // Phone number (Chinese)
  { pattern: /1[3-9]\d{9}/g, replacement: '[PHONE_REDACTED]' },
  // ID card (Chinese)
  { pattern: /\d{17}[\dXx]/g, replacement: '[ID_REDACTED]' },
];

/** 对导出数据进行脱敏 */
function maskSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };

  // 脱敏 modelOutput
  if (typeof result.modelOutput === 'string') {
    let masked = result.modelOutput;
    for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
      masked = masked.replace(pattern, replacement);
    }
    result.modelOutput = masked;
  }

  // 脱敏 reasoningContent
  if (typeof result.reasoningContent === 'string' && result.reasoningContent) {
    let masked = result.reasoningContent;
    for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
      masked = masked.replace(pattern, replacement);
    }
    result.reasoningContent = masked;
  }

  // 脱敏 evidence
  if (Array.isArray(result.evidence)) {
    result.evidence = (result.evidence as string[]).map((e) => {
      let masked = e;
      for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
        masked = masked.replace(pattern, replacement);
      }
      return masked;
    });
  }

  return result;
}

/** 简易 Markdown → HTML 转换（服务端，用于报告导出） */
function simpleMarkdownToHtml(md: string): string {
  let html = md
    // 转义 HTML
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 代码块（```...```）
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
      const unescaped = code.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      return `<pre><code class="language-${lang}">${unescaped}</code></pre>`;
    })
    // 行内代码
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 标题
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // 粗体/斜体
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // 引用块
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    // 合并连续引用块
    .replace(/<\/blockquote>\n<blockquote>/g, '\n')
    // 水平线
    .replace(/^---$/gm, '<hr>')
    // 无序列表
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // 图片
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
    // 链接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // 段落（连续非空行）
    .replace(/\n\n+/g, '</p><p>')
    .replace(/^(?!<[hbpluic]|<\/)/gm, '<p>$&')
    .replace(/(?<!>)$/gm, '</p>')
    // 清理空标签
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/<p><(h[1-4]|ul|pre|blockquote|hr)/g, '<$1')
    .replace(/<\/(h[1-4]|ul|pre|blockquote|hr)><\/p>/g, '</$1>');

  // 表格处理
  html = html.replace(/\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/g, (match: string, header: string, rows: string) => {
    const hCells = header.split('|').filter((c: string) => c.trim()).map((c: string) => `<th>${c.trim()}</th>`).join('');
    const rRows = rows.trim().split('\n').map((row: string) => {
      const cells = row.split('|').filter((c: string) => c.trim()).map((c: string) => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table><thead><tr>${hCells}</tr></thead><tbody>${rRows}</tbody></table>`;
  });

  return html;
}

/** 生成莫兰迪风格 HTML 报告页面 */
function markdownToMorandiHtml(md: string, modelName: string): string {
  const bodyHtml = simpleMarkdownToHtml(md);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>评测报告 — ${modelName}</title>
<style>
  :root {
    --bg: #f5f2ed;
    --card-bg: #faf8f5;
    --text: #26221e;
    --text-secondary: #55504a;
    --heading: #3d6b4f;
    --accent: #9a5b3a;
    --accent-light: rgba(154, 91, 58, 0.12);
    --table-header-bg: #4f7d5f;
    --table-header-text: #ffffff;
    --table-stripe: rgba(79, 125, 95, 0.06);
    --code-bg: #ece4da;
    --blockquote-border: #c08a2d;
    --blockquote-bg: rgba(192, 138, 45, 0.10);
    --border: #d9d2c8;
    --link: #2f6b8a;
    --strong: #b0472a;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.85;
    font-size: 15px;
    padding: 40px 20px;
  }
  .container {
    max-width: 860px;
    margin: 0 auto;
    background: var(--card-bg);
    border-radius: 12px;
    padding: 48px 56px;
    box-shadow: 0 2px 16px rgba(0,0,0,0.04);
    border: 1px solid var(--border);
  }
  .header-bar {
    text-align: center;
    padding-bottom: 32px;
    margin-bottom: 36px;
    border-bottom: 2px solid var(--accent);
  }
  .header-bar h1 {
    font-size: 1.8em;
    color: var(--heading);
    margin-bottom: 6px;
  }
  .header-bar .subtitle {
    color: var(--text-secondary);
    font-size: 0.95em;
  }
  h1 { font-size: 1.5em; color: var(--heading); border-bottom: 2px solid var(--border); padding-bottom: 8px; margin: 32px 0 16px; }
  h2 { font-size: 1.25em; color: var(--heading); margin: 28px 0 12px; }
  h3 { font-size: 1.1em; color: var(--accent); margin: 20px 0 10px; }
  h4 { font-size: 1em; color: var(--heading); margin: 16px 0 8px; }
  p { margin: 10px 0; color: var(--text); }
  strong { color: var(--strong); }
  em { font-style: italic; color: var(--text-secondary); }
  a { color: var(--link); text-decoration: underline; }
  code {
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: "JetBrains Mono", "SF Mono", "Consolas", monospace;
    font-size: 0.9em;
    color: var(--accent);
  }
  pre {
    background: #2d2d2d;
    color: #e8e3db;
    padding: 18px 22px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 14px 0;
    font-size: 0.88em;
    line-height: 1.5;
  }
  pre code { background: none; padding: 0; color: inherit; }
  blockquote {
    margin: 14px 0;
    padding: 12px 18px;
    border-left: 4px solid var(--blockquote-border);
    background: var(--blockquote-bg);
    border-radius: 0 6px 6px 0;
    color: var(--text-secondary);
  }
  blockquote p { margin: 0; }
  ul, ol { padding-left: 28px; margin: 10px 0; }
  li { margin-bottom: 5px; }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 28px 0;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 14px 0;
    font-size: 0.92em;
  }
  table th {
    background: var(--table-header-bg);
    color: var(--table-header-text);
    padding: 10px 14px;
    text-align: left;
    font-weight: 600;
  }
  table td {
    padding: 8px 14px;
    border: 1px solid var(--border);
  }
  table tr:nth-child(even) td {
    background: var(--table-stripe);
  }
  .footer {
    text-align: center;
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.85em;
  }
  @media print {
    body { background: #fff; padding: 0; }
    .container { box-shadow: none; border: none; max-width: 100%; padding: 24px; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header-bar">
    <h1>📊 评测分析报告</h1>
    <p class="subtitle">模型：${modelName} | 智秀大模型评测 生成</p>
  </div>
  ${bodyHtml}
  <div class="footer">
    <p>由 智秀大模型评测 AI Judge 自动生成 | ${new Date().toLocaleDateString('zh-CN')}</p>
    <p style="margin-top:4px;font-size:0.8em;">使用 Ctrl+P → 另存为 PDF 即可导出</p>
  </div>
</div>
<script>window.onload=function(){document.title='评测报告_${modelName.replace(/'/g, "\\'")}'};</script>
</body>
</html>`;
}
