# 04 · 评测引擎核心（packages/core）

## 1. 概述

`@zxbench/core` 是评测引擎核心，纯 TypeScript ESM 包，被后端 `apps/server` 依赖。统一入口在 [packages/core/src/index.ts](../../packages/core/src/index.ts)，导出模型调用、评分器、Judge、安全、沙箱、隐藏测试、解析器、编排器、多轮评测、报告、参数化等能力。

包结构：

```text
packages/core/src/
├── index.ts              # 统一导出
├── orchestrator.ts       # 单题评测编排（11 阶段）
├── model/                # 模型调用（caller.ts / index.ts）
├── evaluators/           # 确定性评分器（10 个）+ 注册表
├── judge/                # 分层 AI Judge + 提示词
├── safety/               # 安全红线检测
├── sandbox/              # 子进程沙箱执行
├── hidden-tests/         # 隐藏测试执行与评分
├── parsers/              # 多格式输出解析器
├── multi-run/            # 多轮稳定性评测
├── parameterize/         # 题目参数化（反污染）
├── report/               # 报告 / 对比报告生成
└── scripts/              # rescore 脚本
```

## 2. 编排器 orchestrator.ts（核心流程）

[orchestrator.ts](../../packages/core/src/orchestrator.ts)

`orchestrateEvaluation(options): Promise<ScenarioResult>` 执行单题评测完整流程，11 个阶段（文件头注释，[orchestrator.ts](../../packages/core/src/orchestrator.ts#L1-L14)）：

| 阶段 | 说明 |
| --- | --- |
| 1 固化配置 | 固定运行配置与题目版本（`onProgress('initializing')`） |
| 2 调用模型 | `callModelWithRetry`；**推理模型多级 token 预算重试**：检测空输出 + `finish_reason=length` 时按 `16384 → 32768 → 65536` 升级重试（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L82-L109)）。**开启思考约束（`constraints`）时预算被硬性封顶，不再升级**：超时或预算耗尽且无有效输出 → 直接构造"思考超限"失败结果（`reasoningLimitExceeded`，0 分），快速推进队列 |
| 2b 空响应兜底 | 重试耗尽仍空 → 返回 `empty_response` 失败结果（axisScores `{format_valid:0, empty_response:100}`，totalScore 0）（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L111-L161)） |
| 3-4 提取元数据 | `buildOutputMetadata`；提取 LM Studio 原生 `stats/timings` tokens/s、`inferenceMs`（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L164-L182)） |
| 5 格式验证 | `structuredOutputEnabled` 且题有 schema 时提取 JSON 并 parse（`formatParseSuccess`）（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L185-L197)） |
| 7 确定性评分 | `getEvaluator(grader, version)` 调用评分器；无评分器时降级基础分（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L199-L214)） |
| — 格式盲区检测 | `formatBlindspot`：代码提取失败 / 有实质输出但极低分 / JSON 解析失败 → 调高 Judge 权重（0.3 确定性 / 0.7 Judge）（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L216-L266)） |
| 6 安全检查 | `checkSafetyRedLines`（红线 → totalScore=0）（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L232-L245)） |
| 8 AI Judge | `runTieredJudge`，按维度/题型权重路由（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L247-L283)） |
| 9 聚合评分 | 确定性 + Judge 加权合并 |
| 10 判定 | 置信度、异常、人工复核标记 |
| 11 审计 | 返回带证据/历史/元数据的 `ScenarioResult` 供持久化 |

**权重决策函数 `getJudgeWeights(dimension, grader)`**（[orchestrator.ts](../../packages/core/src/orchestrator.ts#L33-L56)）：

| 维度 / grader | deterministic | judge |
| --- | --- | --- |
| data_extraction / json_atomic_fields | 1.0 | 0.0 |
| safety_authority | 1.0 | 0.0 |
| structured_output / schema_compliance | 0.9 | 0.1 |
| reasoning_math | 0.95 | 0.05 |
| program / code_repair | 0.8 | 0.2 |
| bug_finding | 0.4 | 0.6 |
| instruction_following / instruction_checklist | 0.5 | 0.5 |
| agent_workflow / agent_trace | 0.7 | 0.3 |
| tool_cli_workflow / tool_call_trace | 0.7 | 0.3 |
| cli_deep_tasks / cli_command | 0.5 | 0.5 |
| 默认 | 0.6 | 0.4 |

> 覆盖率感知合并：评分器输出 `axisCoverage`（已测轴权重占比）。确定性评分器未测量轴（题集缺检查项）的权重在 **AI Judge 参与时让渡给 Judge 语义补判**；Judge 未参与时按覆盖率打折（`LOW_COVERAGE_SCORE_FACTOR=0.3`），避免"唯一已测轴归一成满分"。

## 3. 模型调用 model/caller.ts

[model/caller.ts](../../packages/core/src/model/caller.ts)

- `callModel(options)`：调用 OpenAI Chat Completions 兼容接口（`{baseUrl}/chat/completions`）。特性：
  - 超时默认 5 分钟（AbortController），支持外部 `signal`。
  - **推理模型**：`reasoningModel=true` 时默认 token 预算 32768（普通 8192），注入专用 system 提示（禁止把答案放进 reasoning），分离 `reasoning_content`/`reasoning` 字段。
  - 组装 `messages`、`max_tokens`、temperature/topP/stop/extra，Bearer 认证。
  - 返回 `content`、`reasoningContent`、`finishReason`（mapFinishReason）、`usage`、`latencyMs`、`raw`。
- `callModelWithRetry(options, maxRetries=3)`：指数退避重试（1s/2s/4s…，封顶 10s）。

## 4. 评分器体系 evaluators/

### 4.1 注册表机制

[evaluators/index.ts](../../packages/core/src/evaluators/index.ts)

```ts
interface Evaluator {
  name: string;
  version: string;
  aliases?: string[];
  evaluate(scenario, modelOutput, outputMetadata, modelResponse?): Promise<Partial<ScenarioResult>>;
}
```

- `registerEvaluator(evaluator)`：以 `name@version` 为 key 注册（含别名）。
- `getEvaluator(name, version?)`：精确匹配 → 前缀模糊匹配 → 忽略版本取最新。
- `listEvaluators()`：枚举已注册评分器。

### 4.2 10 个评分器（`evaluators/*.ts`）

> 评分契约（v3 起）：每个评分轴标注**证据强度** `AxisEvidence`（`verified`=真实执行验证 / `rule`=确定性规则 / `llm`=AI 判分 / `unmeasured`=未测量）。伪轴（常量分、中性分、关键词代理、重复计分）已移除；总分只按**已测量轴**加权，未测量轴不计入分母。报告层据此披露各维度证据构成。

| 评分器 | 文件 | 职责与证据强度 |
| --- | --- | --- |
| bugFindingEvaluator (v3) | [bugFinding.ts](../../packages/core/src/evaluators/bugFinding.ts) | Bug 发现：`verdict_correct`(rule) + `output_completeness`(rule) + `patch_test_pass`(verified，JS/TS 沙箱跑隐藏测试)；根因/patch 质量/纪律不再伪装确定性测量，交由 AI Judge 承担 |
| codeRepairEvaluator (v3) | [codeRepair.ts](../../packages/core/src/evaluators/codeRepair.ts) | 代码修复：JS/TS 沙箱执行测试（`test_pass` verified）；其他语言**真实编译/语法检查**（`compile_check` verified，编译器缺失则 unmeasured）+ diff 分析（patch_quality/scope，rule）+ 静态信号（rule 弱证据） |
| structuredOutputEvaluator | [structuredOutput.ts](../../packages/core/src/evaluators/structuredOutput.ts) | 结构化输出：schema_compliance 原子字段校验 |
| dataExtractionEvaluator | [dataExtraction.ts](../../packages/core/src/evaluators/dataExtraction.ts) | 数据抽取 v3：冻结完整 expected、必需叶路径、全路径 JSON 类型和精确形状；format/field_accuracy/completeness/schema/discipline 全为 rule，统一权重 20/40/20/10/10；兼容历史 v2 重放 |
| exactAnswerLineEvaluator | [exactAnswerLine.ts](../../packages/core/src/evaluators/exactAnswerLine.ts) | 精确答案匹配：format 10% + answer_accuracy 90%（rule）；移除 reasoning_valid 伪轴 |
| instructionChecklistEvaluator (v4) | [instructionChecklist.ts](../../packages/core/src/evaluators/instructionChecklist.ts) | 指令遵循：逐项约束检查；无约束时 compliance 标 unmeasured；**实现 exact_order 顺序约束**；未知约束类型显式 FAIL（不再静默跳过） |
| canaryAuthorityEvaluator | [canaryAuthority.ts](../../packages/core/src/evaluators/canaryAuthority.ts) | 安全权限/权威校验（金丝雀注入） |
| toolCallTraceEvaluator (v3) | [toolCallTrace.ts](../../packages/core/src/evaluators/toolCallTrace.ts) | 工具调用：**结构化调用检测**（非"提及即得分"）+ 参数成对匹配；无 tool/params 时标 unmeasured |
| agentTraceEvaluator (v5) | [agentTrace.ts](../../packages/core/src/evaluators/agentTrace.ts) | 智能体轨迹：结构化调用 + **动作顺序校验**；无检查项时标 unmeasured |
| cliCommandEvaluator | [cliCommand.ts](../../packages/core/src/evaluators/cliCommand.ts) | CLI 命令执行结果评估 |

> 工具：`callMatch.ts`（结构化调用/参数成对检测）、`scoreAggregate.ts`（覆盖率感知加权，防止"唯一已测轴归一成满分"）

> 注：后端启动时通过 [apps/server/src/index.ts](../../apps/server/src/index.ts#L66-L76) 将以上 10 个实例 `registerEvaluator` 注册进引擎注册表。

## 5. AI Judge（judge/）

[judge/index.ts](../../packages/core/src/judge/index.ts)

- 分层路由：第一层本地模型初判（`localModel`）→ 需要时升级顶级模型复核（`frontierModel`）。
- `shouldEscalate(judgeResult, input, threshold)`（[judge/index.ts](../../packages/core/src/judge/index.ts#L25-L56)）升级条件：置信度 < 阈值（默认 0.85）、verdict 与 expected_verdict 冲突、测试通过但 patch 判定错误（或相反）、候选答案截断、无隐藏测试。
- JSON 修复：`repairTruncatedJSON` 处理 max_tokens 截断导致的 JSON 残缺。
- `runTieredJudge`：执行双层裁决并合并 `finalJudge`。
- 提示词在 [judge/prompts.ts](../../packages/core/src/judge/prompts.ts)（`JUDGE_SYSTEM_PROMPT`、`getJudgeSystemPrompt`、`buildJudgeUserPrompt`）。

## 6. 安全红线（safety/）

[safety/index.ts](../../packages/core/src/safety/index.ts)

`checkSafetyRedLines(content, structured, scenarioPrompt)`：上下文感知的规则检测（`RED_LINE_PATTERNS`），每类模式带 `contextExemptions`（题目为安全修复类任务时豁免）与 `requiresRealAction`（真实行为才触发红线）。覆盖：真实密钥泄露、未参数化 SQL、危险 shell 命令等。返回 `level: 'safe' | 'red_line'`。

## 7. 沙箱执行（sandbox/）

[sandbox/index.ts](../../packages/core/src/sandbox/index.ts)

替代 VM2：**子进程隔离**执行不可信代码。`runInSandbox` / `runTestCase` / `runTestSuite`。动态生成 worker 脚本，支持超时（默认 10s）、内存限制（默认 128MB）、文件系统隔离，返回 `SandboxResult{success, stdout, stderr, exitCode, duration, timedOut, oomKilled}`。

## 8. 隐藏测试（hidden-tests/）

[hidden-tests/index.ts](../../packages/core/src/hidden-tests/index.ts)

`runHiddenTests` / `runPublicTests` / `summarizeTestResults` / `calculateTestScore` / `generateTestTemplate`。测试用例类型：normal / boundary / edge_case / exception / regression / security。

## 9. 多轮稳定性评测（multi-run/）

[multi-run/index.ts](../../packages/core/src/multi-run/index.ts)

`runMultipleEvaluations` / `batchMultiRunEvaluation`：同一题运行 N 次（日常回归默认 5，模型比较 10），输出均值/中位数/标准差/Bootstrap 置信区间（本地实现 `bootstrapCI`）/成功率/失败率/截断率。

## 10. 题目参数化（parameterize/）

[parameterize/index.ts](../../packages/core/src/parameterize/index.ts)

反污染（防 memorization）：人名/公司名/城市/颜色从数据池随机生成，数字/日期动态生成。同一 run 内所有模型看到相同实例，不同 run 使用不同实例。`generateVariables` / `instantiateScenario` / `createParameterizedInstance`。utils 中亦有对应实现。

## 11. 报告生成（report/）

[report/index.ts](../../packages/core/src/report/index.ts)

- `generateReport(options)`：单次评测 AI 分析报告。
- `generateCompareReport(options)`：模型对比报告。
- 提示词在 [report/prompts.ts](../../packages/core/src/report/prompts.ts)。

## 12. 格式解析器（parsers/）

[parsers/index.ts](../../packages/core/src/parsers/index.ts)

`parseJSON / parseCSV / parseXML / parseSQL / parseHTML / parseYAML / parseRegex / parseMermaid / parseMarkdown / parseTOML / parseByFormat` 多格式输出解析。

## 13. 依赖关系

```text
@zxbench/core ──▶ @zxbench/types   （类型）
                └─▶ @zxbench/utils    （id/hash/stats/truncation/parameterize）
```
