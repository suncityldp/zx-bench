# ZxBench · 本地大模型评测系统

[English](README.en.md) · 中文

[![CI](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml)

ZxBench 是本地部署的大模型评测平台，提供 Docker 执行、规则评分、可选 AI Judge、实时监控、冻结运行、报告和排行榜。当前应用版本 **v0.2.11**；发布题库 **1.60.0** 有 **803 道来源题、920 个执行实例**，其中 614 道普通题及 189 道来源题对应的 306 个迁移实例按来源题归并计分。

本版提供按需镜像准备、生成前的镜像预检、自动本地配置及部署验收。下面的步骤可以由智能体执行；部署过程不需要模型 API Key，也不会调用候选模型或 Judge。[发布说明](docs/release-v0.2.11.md)

## 部署：按顺序执行

所有 `pnpm` 命令均从仓库根目录执行。首次部署用独立目录；已有部署按后面的升级步骤处理，不要覆盖运行中的工作区。

### 1. 检查环境并获取代码

| 依赖 | 要求 | 检查方式 |
| --- | --- | --- |
| Git | 能访问本仓库 | `git --version` |
| Node.js / npm | Node.js ≥22.13；建议使用受支持的 LTS | `node --version`、`npm --version` |
| pnpm | 按 `packageManager` 固定到 11.21.0 | `pnpm --version` |
| Docker | 执行题需要可访问的 Linux 引擎；当前冻结镜像验证平台为 linux/amd64 | `docker version`、`docker info` |
| 镜像存储 | 冻结 OCI index ID 需要 containerd 镜像存储 | `docker info --format '{{json .DriverStatus}}'` |

缺少 Node.js 或 Docker 时，智能体先按宿主系统通过官方安装入口准备：[Node.js](https://nodejs.org/en/download)、[Docker](https://docs.docker.com/get-started/get-docker/)。安装权限、WSL/虚拟化、系统重启属于宿主环境前置条件；遇到限制应报告具体缺项，不能跳过后声称部署完成。pnpm 不存在或版本不符时执行：

```sh
npm install --global pnpm@11.21.0
```

```sh
git clone https://github.com/suncityldp/zx-bench.git
cd zx-bench
git rev-parse HEAD
pnpm --version
```

Docker 应先启动再检查。Windows Docker Desktop 使用 Linux containers；若诊断提示 `IMAGE_STORE_IDENTITY`，按 [Docker 存储说明](https://docs.docker.com/desktop/features/containerd/) 使用兼容的 containerd 存储。切换存储会隐藏另一模式已有的镜像和容器，准备工具不会自行修改该全局设置。检查缺失镜像时，不要删除镜像、关闭冻结 ID 校验或重写题库。

### 2. 安装、配置、初始化并构建

```sh
pnpm install --frozen-lockfile
pnpm setup:env
pnpm --filter server prisma:generate
pnpm db:push
pnpm build
```

`setup:env` 自动生成 `apps/server/.env`，设置端口 3001、监听 `127.0.0.1`、SQLite 路径及随机加密密钥，不打印密钥；已有文件原样保留。默认数据库实际位于 `apps/data/zxbench.db`，因为 `DATABASE_URL` 相对 `apps/server/prisma` 解析。初始化不会清空已有数据库。不要上传 `.env` 或数据库，也不要在已有模型配置后更换加密密钥。

成功条件：每条命令退出码为 0，生成 Prisma 客户端、数据库表及前后端 `dist`。命令失败即停在该步，修复原始报错后重试；不要继续启动旧构建。

需要其他端口时，首次生成配置用 `pnpm setup:env --port 31001`；已有配置修改其 `PORT`。后续在线检查使用对应的 `BASE_URL`：PowerShell 用 `$env:BASE_URL='http://127.0.0.1:31001'`，POSIX shell 用 `export BASE_URL=http://127.0.0.1:31001`。

### 3. 启动服务并等待健康检查

前台运行：

```sh
pnpm --filter server start
```

这是长期运行的服务，不会自行退出。智能体可在后台启动后继续执行第 4 步；保留 PID 和日志。已启动同版本服务时不要重复启动。

Windows PowerShell：

```powershell
$deploymentRoot = (Get-Location).Path
New-Item -ItemType Directory -Path logs -Force | Out-Null
$serverProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'dist/index.js' -WorkingDirectory (Join-Path $deploymentRoot 'apps/server') -RedirectStandardOutput (Join-Path $deploymentRoot 'logs/server.out.log') -RedirectStandardError (Join-Path $deploymentRoot 'logs/server.err.log') -WindowStyle Hidden -PassThru
$serverProcess.Id | Set-Content logs/server.pid
```

macOS / Linux shell：

```sh
mkdir -p logs
(cd apps/server && exec node dist/index.js) >logs/server.out.log 2>logs/server.err.log &
echo $! > logs/server.pid
```

轮询 `GET http://127.0.0.1:3001/api/health`，等待最多 60 秒；成功条件是 HTTP 200、`status: "ok"`、`version: "0.2.11"`。Windows 可用 `curl.exe -fsS http://127.0.0.1:3001/api/health`，其他系统用 `curl -fsS`。失败时读 `logs/server.err.log`、`logs/server.out.log`；端口冲突先确认进程归属，不要强杀其他部署或用户进程。服务会提供已构建的前端，不需要再启动 Vite。

### 4. 同步并核验题库

保持后端运行，在另一个终端或后台启动后的同一智能体会话执行：

```sh
pnpm bank:sync
pnpm bank:check
```

成功条件：**失败 0、缺失或非有效 0、哈希不符 0**，两条命令退出码为 0。导入默认只新增或更新发行定义，保留其他题目、历史运行与答卷，不需要 `--reset`。`Released benchmark database incomplete` 表示这一步未完成；更新代码或磁盘 JSON 不会自动更新数据库。

### 5. 检查缺哪些镜像，只准备缺失项

运行全部发行题目时：

```sh
pnpm runtime:prepare --check
pnpm runtime:prepare
pnpm runtime:check
```

第一条只生成计划，不下载；第二条自动跳过已满足契约的镜像。Python、Node、GCC 按固定 digest 拉取，校验后恢复题库所需 tag；自定义镜像按独立资产下载，校验文件 SHA-256 和大小后导入，再核验实际镜像 ID。缓存位于 `tmp/runtime`，再次执行会复用已验证内容。**不需要下载整包，不遍历历史 tag，不需要私有 Harbor 账号。**

镜像资产下载遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（也支持小写），无需智能体把代理写进代码；Docker 拉取使用引擎自身的代理配置。工具不打印代理地址或凭据，也不关闭 TLS 验证。

只运行部分题目时，可以按实际范围准备；筛选参数可重复使用：

```sh
pnpm runtime:prepare --dimension cli_deep_tasks --check
pnpm runtime:prepare --dimension cli_deep_tasks
pnpm runtime:prepare --scenario CLI-CN-002-DOCKER
pnpm runtime:prepare --image python:3.12-alpine
```

按范围准备后，用相同筛选再执行 `runtime:prepare --check`，确认全部为 `[skip] ... ready`；全库 `runtime:check` 仍会报告范围外的缺失项，这是完整检查的预期结果。小型 Python 离线包约 18 MiB；GCC 约 474 MiB、Java 约 281 MiB，仅在对应题目需要时获取。

离线机器把所需 Release 单镜像资产放进同一目录，再用 `pnpm runtime:prepare --cache-dir /path/to/archives`；不修改 manifest 或校验值。具体镜像、大小、固定 ID、下载地址见 [runtime manifest](docker/execution-images/runtime.json)，恢复步骤见 [Docker 排错](docs/docker-deployment-troubleshooting.md)。

`runtime:check` / `runtime:prepare` 覆盖题库**显式声明**的镜像。评分器内部的其他语言运行时、网络依赖和目录挂载仍需按实际题目验证；准备通过不等于所有语言测试已经执行。评测会在生成前检查显式镜像契约，缺失或 ID 不符时暂停且尚未请求模型。已生成的历史环境错误不会自动改分。

### 6. 完成部署验收

```sh
pnpm deploy:check
```

成功条件：退出码为 0，输出 `ready: true`、正确版本、`frontend: "ready"`、题库缺失与哈希不符均为 0。该命令检查健康 API、版本 API、首页及前端资源、在线题库，只读且 `modelRequests: 0`。执行题的镜像就绪还需满足第 5 步所选范围的检查。

最后打开 <http://127.0.0.1:3001>。智能体交付部署结果时报告实际 commit、服务地址/PID、题库检查结果、镜像准备范围与尚未满足的依赖，不能仅凭进程启动就报告完成。此后按用户选择在 WebUI 添加模型；连通性测试、Judge 预检和正式评测会请求模型，不属于部署验收。

## 升级已有部署

1. 暂停评测并停止本部署的服务进程；按实际 `DATABASE_URL` 备份 SQLite 文件及仍存在的 WAL/SHM，备份 `apps/server/.env`。不要停止其他部署。
2. 在干净工作区执行 `git pull --ff-only`，重复第 2 步安装、初始化、构建。已有本地改动先保留，不使用 `git reset --hard`；配置和密钥不会被 `setup:env` 覆盖。
3. 重新启动服务，确认健康接口显示新版本，再执行 `bank:sync`、`bank:check`、所选范围的 `runtime:prepare` 和 `deploy:check`。

代码升级、题库导入、镜像准备均不会自动重评历史成绩或替换运行中冻结的题包。[历史重评说明](docs/release-v0.2.10.md) · [已保存编程答案恢复](docs/docker-readiness-and-saved-answer-recovery.md)

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
