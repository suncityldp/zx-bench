# ZxBench · 本地大模型评测系统

[English](README.en.md) · 中文

[![CI](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml)

ZxBench 是本地部署的大模型评测平台，提供 Docker 执行、规则评分与可选 AI Judge、实时监控、冻结题集、报告和排行榜。发布题库 **1.60.0 / v0.2.6** 默认采用九模型实际使用的题包：**803 道来源题**，由 **614 道普通题 + 189 道来源题的 306 个迁移执行实例**组成。全量执行 920 个实例，计分归并回来源题。

最近的更新把五个执行相关维度的题目逐步迁到可重置的 Docker 任务包，并改进了冻结题集、渐进式多问上下文、执行证据与评分审计。**v0.2.4** 还加入严格执行题最终答复的可选语义 Judge 复核：它只在其他检查通过后参与判定，保留原规则分和审计记录；无效 Judge 输出进入人工复核。

**v0.2.6** 修复工作流题目契约、只读确认规则和 `ANSWER/SAY` 最终答复解析；87 个智能体实例采用检查点 rubric，最终未通过最高 40 分，安全违规为 0 分。详见[修复与验收说明](docs/workflow-repair-2026-10-01.md)。

## 快速开始

需要 Node.js ≥22.13、pnpm ≥11；运行编程和 Docker 执行任务还需要已启动的 Docker，以及题目指定的本地镜像。缺失镜像或 Docker 不可用属于环境未就绪，不应解释为模型能力失败。

```bash
pnpm install
pnpm --filter server prisma:generate
# 将 apps/server/.env.example 复制为 apps/server/.env，并按需配置
pnpm build
pnpm --filter server start
```

工作流技能题还需要发布时冻结的 PyYAML 镜像。运行 `pnpm runtime:workflow`，自动下载 v0.2.6 镜像资产并校验 SHA-256 与 Docker image ID。离线可用 `pnpm runtime:workflow --archive /path/to/image.tar.gz`。镜像为 Linux amd64；Windows Docker Desktop 需使用 Linux 容器。

打开 <http://127.0.0.1:3001>。Windows 也可使用 `start.bat`；macOS/Linux 使用上面的 pnpm 命令。首次使用或题库更新后，运行 `node scripts/seed-benchmark.mjs` 导入 `data/scenarios/benchmark.json`。导入会清理发行集合外的在线题目定义，保留历史运行和答卷；新建运行按发布题目 ID 与内容哈希选择，数据库中同 ID 定义漂移会报错。**GitHub 更新不会自动更新在线数据库，也不会改变运行中任务的冻结题目**；发布与数据库同步步骤见[题库更新说明](docs/question-refresh-2026-09-28.md)。

## 题库与评分

下表区分默认九模型题包的来源题数量和执行实例数量。维度、难度筛选或显式选取发行题号会缩小评测范围。

| 维度 | 来源题 | 执行实例 | 综合分权重 |
|---|---:|---:|---:|
| `program` | 150 | 150 | 0.17 |
| `hallucination_resistance` | 134 | 134 | 0.12 |
| `reasoning_math` | 106 | 106 | 0.12 |
| `data_extraction` | 104 | 104 | 0.07 |
| `structured_output` | 60 | 60 | 0.05 |
| `tool_cli_workflow` | 55 | 98 | 0.07 |
| `cli_deep_tasks` | 52 | 56 | 0.07 |
| `safety_authority` | 50 | 78 | 0.10 |
| `agent_workflow` | 45 | 87 | 0.08 |
| `instruction_following` | 42 | 42 | 0.12 |
| `agent_loop` | 5 | 5 | 0.03 |
| **合计** | **803** | **920** | **1.00** |

每题按难度加权（easy 1、medium 1.5、hard 2、adversarial 2.5）；`long_task_*` 编程长任务显式使用 **3.0**。迁移实例先按原来源题取均分，使用来源题原难度和类别权重，再求维度均分与综合分。规则评分器验证可确定的条件；需要语义判断的部分可按题型使用 Judge。执行环境错误、模型失分、Judge 失败与规则/Judge 冲突分别留证；`scoringComplete=false` 的运行不进入排行榜。重试结果按尝试链中最新有效结果计算，不同题库、选题和运行条件下的总分不可直接混排。

数学精确答案题另记录 `content_accuracy`，用于区分“答案内容正确”与 `ANSWER:` 等格式要求。它**不参与综合分**，格式违规仍按正式规则扣分；仅在内容可独立核验且题目哈希匹配时产生该诊断值。

## Docker 迁移后的执行测试

**v0.2.5 已将这批迁移任务纳入默认题包。** 189 道来源题对应 306 个执行实例；被替换的旧原题已从在线发行集合移除。历史答卷仍保留在冻结运行中。执行契约保留原 `developmentShadow` 标记与哈希，只有当前发行清单明确列出的实例进入默认评测。

- **真正执行而非只看文字。** CLI/脚本题在隔离容器里运行候选脚本，检查标准输出、产出文件和 Git 工作区状态。工具与智能体题使用可重置的本地模拟世界，依据工具调用轨迹、状态变化、最终结果和禁止副作用判分。
- **测试长链路与故障恢复。** 场景可包含前置查询、权限确认、部分成功、超时或响应丢失。例如邮件已送达部分收件人时，模型须先核查状态再补发剩余对象；扣款已落账却丢失响应时，须查询确认，不能换键重复扣款。邮件和资金都是本地合成状态，不触达真实外部系统。
- **保存可复查的契约与证据。** 任务包记录题目、执行器、验证器和参考脚本指纹；参考动作与核心错误反例用于检查判分边界。题目、环境或执行契约改变需重新作答；仅评分逻辑改变且旧证据充分时才可离线重评。运行预算、终止原因及环境故障单列记录。

任务包、映射及核验入口见 `data/scenarios/benchmark-release.json`、`data/execution/tasks/` 和[执行任务包维护说明](docs/execution-task-governance.md)。固定镜像需要预先准备；参考解与反例检查覆盖关键规则，尚不能证明所有等价解都被接受或新题已经有稳定的模型区分度。

## 渐进式试题：分问、承接与部分得分

渐进式题将同一问题拆为 **四个相互关联的小问**，逐问发起模型请求。后问只收到同组前问的冻结题面和模型**已完整提交的评分项**；隐藏思考、标准答案、得分及对错反馈不会传入。前问答错或未交完整答案仍可进入下一问；不同组重新开始上下文。重试时检查已有后问，避免把不同尝试拼成一段对话。

每问可逐项提交结构化答案，同一评分项以最后一条完整合法记录为准。超时或截断时保留已经完整提交并通过核验的评分项，不完整尾部不覆盖旧提交；环境或运行中断单独标注。分问分值与预算在试卷中冻结，报告同时呈现部分得分和终止原因。这个设计考察模型能否在有限预算下沿用自身既有结论、继续推理并及时交卷；**预设分值递增不等于已证明后问更难**，相关试跑与限制见[渐进式试卷记录](docs/progressive-exam-2026-09-14.md)。

## 编程长任务与工程能力

编程维度包含单文件修复、无需修复陷阱题，以及 **20 道多文件 `long_task_*` 工程题**：调试 8 道、实现 2 道、重构 10 道。长任务要求理解现有文件关系、提交按路径标注的完整文件内容，并维持多步骤修改的上下文。`project_repair` 会把替换文件写入隔离工作区，注入模型不可见的测试文件并运行测试；评分还分别考察 API 保持、静态信号、输出完整性和改动范围。报告单列长任务得分及失败模式，避免它被编程维度均分掩盖。

单文件 `code_repair@4.14.0` 有 107 道修复题和 345 个冻结正式测试 ID。执行使用资源受限容器或受限编译进程，期望值由控制端持有。部分多文件题的正向金标覆盖仍不完整；容器执行及测试通过不能证明任意仓库语义或恶意代码安全性。具体门槛见[发布门槛与限制](docs/lightweight-release-gate.md)。

## 运行、核验与报告

- 可创建单模型评测或最多 8 个不同模型的批量评测，各模型独立运行；题目并发数 1–4，默认 4。
- 推理模型可设置生成预算、思考链上限和单题硬时限。运行级 `Max Tokens` 是请求硬上限，题级约束只能收紧它；比较成绩时应核对服务端上下文、输出限制及超时记录。
- 实时监控支持暂停、恢复、取消和单题重试；报告与排行榜展示维度分及证据。批量监控可切换模型查看。
- 创建评测时预检所选 Judge；冻结运行可先只读审计，再按需重算评分。使用 `pnpm --filter server run:verify-score <run-id> [database-url]` 只读核验题集、题级结果、维度分和总分。`--repair-summary` 会先备份数据库，仅在确需修复旧缓存摘要时使用。
- `pnpm test` 运行回归测试；`pnpm test:containers` 运行 Docker 正反例检查；`pnpm build` 验证构建。CI 在 push/PR 后安装依赖、生成 Prisma 客户端、构建并测试。

更多方法与边界见[评分可信度与发布闸门](docs/scoring-integrity.md)及[评测可靠性实现](docs/evaluation-reliability-implementation-2026-09-09.md)。

## 公开测评与结果

[九模型语义复核报告](docs/semantic-judge-nine-model-rescore-2026-09-29.md)与[最新定向成绩和 Token 用量](docs/nine-model-latest-score-tokens-2026-09-29.md)使用同版 **803 道来源题**的保存答卷；其中 189 道 Docker 来源题按 306 个执行实例折算。迁移题包含开发/先导轨道证据，这些九模型对照**不是正式排行榜的直接替代**，也没有覆盖历史运行结果。

[五模型全维度测评报告（2026-09-25）](analysis/swift-five-model-report/Swift与五模型全维度测评报告-20260925.md)比较 Swift、GSQ-RCO、NVFP4、Bonsai-2 Q1 和 ByteShape 的 **801 道共同题、十个维度**，包含递进题重跑、Token 用量、替代计分、图表与逐题格式复核。它是旧版历史分析，不等同于当前题库或跨硬件速度基准。[下载 PDF](output/pdf/Swift与五模型全维度测评报告-20260925.pdf) · [打开便携 HTML](analysis/swift-five-model-report/Swift与五模型全维度测评报告-单文件.html)

## 项目结构

```text
apps/web/        React 前端
apps/server/     Fastify API、Prisma、WebSocket
packages/core/   调用、执行、评分、报告核心
packages/types/  共享类型
data/scenarios/  当前题库、元数据与归档
data/execution/  Docker 执行任务包、迁移映射与证据
scripts/         题库导入、导出及审计工具
docs/            方法说明与更新记录
analysis/swift-five-model-report/  五模型报告与复核数据
```

MIT License · Copyright (c) 2026 ZhiXiu Contributors
