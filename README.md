# ZxBench · 本地大模型评测系统

[English](README.en.md) · 中文

> 在一台机器上，对任意大模型（本地 GGUF / Ollama / OpenAI 兼容 API）跑完 10 大维度、**595 道**基准题（题库累计 673 道，其中 78 道已退役旧题归档于 `data/scenarios/archive/`，不参与评测），产出可复现的综合分、维度雷达、排行榜、AI 深度报告与性价比分析。其中编程题在 **Docker 容器里真实编译并执行隐藏测试**，分数反映的是真实代码行为，而非「看起来像」的文本相似度。

[![CI](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml)

## 核心特性

- **10 大能力维度**：编程、推理数学、安全权限、深度 CLI、数据抽取、智能体工作流、指令遵循、工具/CLI、幻觉抵抗、结构化输出。
- **595 道可评测基准题**（题库累计 673 道，退役旧题归档保留版本史）：难度分级（easy/medium/hard/adversarial）、带版本控制（每题 scenarioHash，题库 `benchmark-meta.json` 版本化）。
- **编程题真实执行**：JS/TS/Python 默认容器执行；Go/Java/C/C++/Rust/PHP/C#/Bash/SQL 按 fixture 在 Docker 中编译/运行隐藏测试。缺少测试的题明确保留未测状态，不把静态检查当作行为通过。内存检查、race detector 等按题配置启用。
- **no_bug 陷阱题**：部分代码本身正确，模型须识别「无 bug」而非强行修改，误修会扣分。
- **确定性评分 + AI Judge 双通道**：规则评分器先判，AI Judge 按维度权重补判语义项，覆盖率感知地「让渡」权重。
- **综合分（难度加权 + 维度加权）**：高难题权重更大、按维度重要度加权求和，避免「均分」被题量带偏。
- **反拖尾**：推理模型思考链硬上限、单题硬时限（默认 300s）、超限即判，不再无限升级 token 预算。
- **实时监控 + 断点续跑**：WebSocket 实时进度、暂停/恢复/取消、单题重试、fork 分叉维度。
- **报告与排行榜**：自动聚合维度图表、AI 深度报告、模型排行榜、模型性价比散点图。
- **回归测试 + CI**：评分、聚合、金标与契约均有自动回归，GitHub Actions 自动构建并测试。

---

## 题目与真实执行（关键设计）

ZxBench 的编程题不是「模型输出一段代码、用关键词判断像不像答案」，而是**把模型的修复结果放进隔离环境里真的编译、真的跑测试**：

| 语言 | 执行后端 | 验证方式 |
|------|----------|----------|
| JavaScript / TypeScript | node:20-alpine 容器（运行测试时转译 TS） | 隐藏断言与完成证据；类型专项另有 strict 检查 |
| Python | python:3.12-alpine 容器 | assert、语法检查与完成证据 |
| Go | zxbench/go:1.21-gcc 容器 | 编译测试二进制后执行；完整固定分母，并发题可开 -race |
| Java | maven:3.9-eclipse-temurin-17-alpine 容器 | javac + JUnit；校验完整报告与退出状态 |
| C / C++ | zxbench/cpp:gcc13-valgrind 容器 | 编译 + 断言；fixture 可启用 Valgrind，并非所有题默认检查内存 |
| Rust | rust:1.75-alpine 容器 | rustc + assert；编译与运行失败分开 |
| PHP | php:8.2-cli-alpine 容器 | 显式开启 zend.assertions/assert.exception |
| C# | .NET SDK 8.0-alpine 容器 | dotnet build + 自定义 Assert |
| Bash | bash:5 容器 | -e / pipefail、语法检查与完成证据 |
| SQL | node:22-alpine 容器 | node:sqlite 建表+插数+查询+结果集比对（性能题用 EXPLAIN 计划检查） |

除常规「修复 bug」题外，编程维度还包含：

- **no_bug 陷阱题**：代码正确，模型须输出 `NO_FIX_NEEDED` 并说明原因；强行修复得 0 分。
- **plan 题**：方案评审 / 故障诊断（数据库零停机迁移、p99 延迟排查等），按步骤 checklist 评分，已归入指令遵循维度。
- **实现题**：给定签名与类型约束补全实现（如 safeParseInt、Top-N 查询）。

2026-09-12 新增跨 12 种语言的真实容器正反例回归（`pnpm test:containers`）。这验证执行器，不代表现有每一道编程题都已通过独立金标双向复核；历史题的 referenceSolution/fixture 覆盖仍不完整。默认容器无网络、非 root、工作区只读；部分构建题允许工作区写入。容器根目录并非全部只读，完成标记也不是防恶意篡改的安全边界。

### 2026-09-12 执行与评审可靠性升级

`code_repair@3.4.0`、`instruction_checklist_v5`、`llm_judge@2.0.0` 已冻结 171 条当前题目契约；修复了指令题的跨段引用、嵌套结构、逐项对应与局部计数漏判。PR 评审要求严格 JSON、文件绑定和 diff 原文证据；新发现未匹配、Judge 失败均显式留待复核。历史分数不自动覆盖，新旧版本不能直接混比。详见[交付范围、验证与剩余限制](docs/execution-instruction-pr-v2.md)。

---

## 快速开始

### 环境要求

- Node.js ≥ 22.13（pnpm 11 与内置 node:sqlite 需要）
- pnpm ≥ 11
- **Docker**（编程题容器执行必需）

首次评测前会自动拉取所需镜像；也可手动预热。编程题有**两套执行后端**：

**① 单文件修复题（code_repair / sandbox）**

```bash
docker pull golang:1.21 eclipse-temurin:17-jdk-alpine gcc:13 rust:1.75 php:8.2-cli mono:6.12 bash:5 node:22-alpine
```

**② 多文件工程修复题（project_repair，CP-L4）**

```bash
docker pull python:3.12-alpine node:20-alpine golang:1.22-alpine maven:3.9-eclipse-temurin-17-alpine rust:1-alpine gcc:13 mcr.microsoft.com/dotnet/sdk:8.0 php:8.2-cli-alpine bash:5 postgres:15
```

> 环境要点（Environment Notes）：
> - project_repair 容器以**非 root（UID 65534）**运行，grader 注入 `HOME=/tmp` 保证 dotnet / go / npm 的缓存目录可写（否则 `HOME=/nonexistent` 会 EACCES）。
> - Java 工程题使用预构建镜像 `zxbench/java-spring:3.2.5`（首次由场景脚本自建）；C/C++ 内存检查使用 `zxbench/cpp:gcc13-valgrind`。
> - 受限容器（非 root + cap-drop + no-new-privileges）下 **AddressSanitizer 不可用**（会 DEADLYSIGNAL），C/C++ 内存安全改由 Valgrind / 测试断言覆盖。
> - Java 单文件题的 JUnit jar 已内置在 data/java-libs/，随仓库分发，无需额外下载。
>
> The programming dimension has **two execution backends**:
> ① Single-file repair (code_repair / sandbox): first `docker pull` list above.
> ② Multi-file project repair (project_repair, CP-L4): second list above.
> project_repair containers run as **non-root (UID 65534)** and the grader injects `HOME=/tmp` so dotnet/go/npm caches stay writable. Java project scenarios use prebuilt `zxbench/java-spring:3.2.5`; C/C++ memory checks use `zxbench/cpp:gcc13-valgrind`. ASan is disabled under the restricted container (would DEADLYSIGNAL), replaced by Valgrind / asserts.

### 安装与启动

```bash
# 1. 安装依赖
pnpm install
pnpm --filter server prisma:generate

# 2. 配置环境变量
cp apps/server/.env.example apps/server/.env

# 3. 构建
pnpm build

# 4. 启动（Windows 一键脚本，带 watchdog 自动重启）
start.bat

# 或手动启动后端（默认端口 3001）
pnpm --filter server start
```

浏览器访问 http://127.0.0.1:3001。

### macOS 专属说明

本项目是标准 pnpm + Node/TypeScript + Docker monorepo，源码无平台专属依赖，**macOS（Intel 与 Apple Silicon 均支持）可直接运行**。注意以下几点：

- **用 pnpm 脚本启动，不要用 `start.bat` / `start-server.ps1`**：这两个是 Windows 便利脚本，macOS 上不可用。请用：
  ```bash
  pnpm install && pnpm build
  pnpm --filter server start        # 或 pnpm dev 一键起前后端
  ```
- **先装 Docker Desktop for Mac**：编程维度所有语言都跑在容器里，评测前请确认 Docker Desktop 已启动（否则编程维度会整体 `Docker unavailable` 跳过）。`node:20-alpine` / `python:3.12-alpine` / `bash:5-alpine` / `postgres:15` 等均为多架构镜像，Apple Silicon 上自动拉取 arm64 原生版本。
- **Node 版本**：用 nvm / fnm / Homebrew 装 Node ≥ 22.13、pnpm ≥ 11；若系统 Node 过旧，`pnpm install` 会因 `engines` 限制报错。
- **无需担心 Windows 的 node_modules 符号链接损坏**：macOS 原生支持 symlink，`pnpm install` 不会复现该问题，`pnpm test` 可正常跑（仓库已加 `pretest` 自动构建 TS 库，clone 后直接 `pnpm test` 即可）。

### 2026-09-08 推理题参考答案修订（issue #7）

34 道数学题已升级为 3.2.0 / exact_answer_v4；78 道新版幻觉题已逐题审查并升级为 5.0.0 / hallucination_v5。数学题检查严格数值和必要构造；幻觉题的简单事实采用完整答案离线校验，其余自然语言必须由 Judge 按逐题 rubric 评分。Judge 不可用的语义题标记为未能评分并排除汇总，不把关键词命中当正确。历史结果保留，旧版本与当前题集不可比。详见[逐题修复与验证](docs/reviewed-question-bank-v5.md)。运行 `node scripts/sync-reviewed-question-contracts.mjs <数据库路径>` 预览；加 `--apply` 自动备份后事务同步 168 道已复核定义，不改写历史结果。

### 2026-09-12 数据抽取题集 v3

数据抽取维度从 35 题扩充到 56 题。原 35 题已逐题对齐题面与金标，新增 21 题覆盖来源优先级、去重、时区、null/false/0、表连接、文档版本、邮件引用、脚注、OCR、多语言、嵌入式指令攻击等场景。`json_atomic_v3` 冻结完整 `expected`、所有路径的 JSON 类型、必需叶路径和禁止额外字段策略；纯规则评分，不调用 Judge。Markdown 围栏、类型强转、缺失 null、额外键和数组长度漂移都会被确定性扣分。所有 56 题均为 3.0.0、`reviewStatus=verified`，并由 canonical `scenarioHash` 锁定。详见[数据抽取 v3 复核与冻结记录](docs/data-extraction-v3-review.md)。

### 导入基准题集

```bash
node scripts/seed-benchmark.mjs   # 导入
node scripts/export-scenarios.mjs # 导出
```

---

## 核心概念：综合分是怎么算出来的

### 10 大评测维度与题量

| 维度 | 中文名 | 题量 | 维度权重 |
|------|--------|------|----------|
| program | 编程能力 | 150 | 0.20 |
| hallucination_resistance | 幻觉抵抗 | 78 | 0.12 |
| reasoning_math | 推理与数学 | 34 | 0.12 |
| instruction_following | 指令遵循 | 42 | 0.12 |
| safety_authority | 安全与权限 | 50 | 0.10 |
| agent_workflow | 智能体工作流 | 45 | 0.08 |
| tool_cli_workflow | 工具/CLI/工作流 | 56 | 0.07 |
| data_extraction | 数据抽取 | 56 | 0.07 |
| cli_deep_tasks | 深度命令行任务 | 56 | 0.07 |
| structured_output | 结构化输出 | 28 | 0.05 |
| **合计** | | **595** | |

> 题量 = `benchmark-meta.json` 中 status=valid 的当前可评测题；另有 78 道已退役旧题（v3 幻觉题集 HAL-*）归档于 `data/scenarios/archive/benchmark-retired.json`，保留版本史但不参与跑测。题库累计 673 道。

### 三步评分链

1. **维度内难度加权均分**：每道题按难度加权（easy=1, medium=1.5, hard=2, adversarial=2.5），高难题影响更大但不过度放大。

```
维度均分 = Σ(题目得分 × 难度权重) / Σ(难度权重)
```

2. **维度加权总分（综合分）**：把各维度均分按「维度权重」加权求和。

```
综合分 = Σ(维度均分 × 维度权重) / Σ(维度权重)
```

3. **确定性评分与 AI Judge 双通道**：每个维度按题型定义 det/judge 权重。当确定性评分器有「未测量轴」（coverage < 1）时，其权重按覆盖率让渡给 AI Judge 补判；无 Judge 且覆盖率 < 0.5 时，总分打 3 折避免未验证给满分。

> 注意：打折只作用于总分，deterministicScore 始终保存「原始」确定性分，已有回归测试锁定。

### 难度分布说明

各维度的难度标签分布并不均匀：agent_workflow / cli_deep_tasks 有 84-86% 的题是 hard/adversarial，而 reasoning_math / structured_output 只有 32-36%。因此**跨维度的分数横向比较需谨慎**——同一分数在不同维度上的难度基线不同。

issue #7 修订前的推理维度历史分数需要重新核验，不应据此推断模型“数学弱、工作流强”等跨维度能力差异。


---

## 页面功能详解

### 1. 总览（Dashboard）
评测系统主页：全局统计、维度雷达图、维度分布表。

![总览](docs/screenshots/dashboard.png)

### 2. 创建评测（EvalCreate）
配置评测参数，支持单模型与多模型并行，提交后跳转实时监控。

![创建评测](docs/screenshots/eval-create.png)

### 3. 实时监控（EvalLive）
评测运行中的实时视图，支持暂停/恢复/取消、fork 分叉维度、单题重试。

### 4. 评测历史（EvalHistory）
所有评测记录列表，支持进入监控、恢复、详情、报告。

![评测历史](docs/screenshots/eval-history.png)

### 5. 评测详情（EvalDetail）
单次评测的逐题明细、证据折叠、单题重试。

### 6. 评测报告（Report / ReportList）
总分、维度雷达、排名、分数分布、评分证据构成、AI 深度报告。

![评测报告列表](docs/screenshots/reports.png)
![单份评测报告](docs/screenshots/report.png)
![AI 报告](docs/screenshots/report-ai.png)

### 7. 排行榜（Leaderboard）
按模型聚合排名，支持「最新 run / 跨 run 最优」两种口径。

![排行榜](docs/screenshots/leaderboard.png)

### 8. 题目管理（Scenarios）
题库管理：查看/编辑/删除、从 Pack 导入（含 SSRF 与路径穿越防护）。

![题目管理](docs/screenshots/scenarios.png)

### 9. 模型对比（CompareModels）
多模型对比报告，逐维度分析差异。

![模型对比](docs/screenshots/compare.png)

### 10. 模型性价比（ModelValue）
综合分为 X 轴、输出 token 为 Y 轴的散点图。

![模型性价比](docs/screenshots/value.png)

### 11. 系统设置（ModelConfig）
模型配置中心：添加/编辑/删除被测模型与 AI Judge 模型。

![系统设置](docs/screenshots/settings.png)

---

## 创建评测 · 设置项说明

### 基础

| 设置项 | 类型 | 说明 |
|--------|------|------|
| 测试模式 | 单选 | 单模型 / 多模型并行 |
| 评测名称 | 文本 | 列表与历史中识别 |
| 被测模型 | 选择 | 推理模型自动分配更大 token 预算（默认 49152） |
| 评测维度 | 多选 | 不选 = 全部 10 维度 |
| Max Tokens | 数字 | 单次生成最大 token 数（默认 8192） |
| Temperature | 数字 | 生成随机性；推理模型强制 1 |
| 每题运行次数 | 数字 | 每题重复运行次数（默认 1） |

### 高级选项

| 设置项 | 类型 | 说明 |
|--------|------|------|
| AI Judge | 开关 | AI Judge 模型二次评分复核 |
| 争议升级 | 开关 | 规则分与 Judge 分分歧时升级复核 |
| 安全红线检查 | 开关 | 安全红线检测（默认开） |
| 隐藏测试 | 开关 | 用隐藏测试用例检验回答（默认开） |
| 结构化输出 | 开关 | structured_output 维度要求结构化输出 |
| AI Judge 模型 | 选择 | 评分复核模型 |
| 并发题目数 | 滑条 | 并发题数（1–4，默认 4） |
| 并行模式 | 单选 | 全局并发池 / 维度独立并行 |

> **幻觉题评分边界**
> 新版简单事实与选项采用完整答案离线验证；其余回答由 Judge 逐点评判。语义题缺少成功的 Judge 时保留回答并排除汇总。材料引用和校验位不等于外部文献真实性；对实际出现的外部引用仍提示人工复核。仅切换到“支持联网”的模型名称不会自动为当前 Chat Completions 调用增加检索工具。

### 思考约束（反拖尾）

应对推理模型（QwQ / DeepSeek-R1 等）无限思考导致超时。

| 设置项 | 类型 | 说明 |
|--------|------|------|
| 先答案后原因 | 开关 | 强制先给最终答案再给原因 |
| 思考链上限 (token) | 数字 | reasoning_content 最大 token（0 = 不限） |
| 单题硬时限 (秒) | 数字 | 单题最长等待（默认 300） |
| 超限处置 | 选择 | 判 0 分 / 降权 / 标记人工复核 |

---

## 系统设置 · 模型配置项说明

| 设置项 | 说明 |
|--------|------|
| 模型 ID | 真实 API 模型 ID |
| 模型名称 | 用户友好显示名（可选） |
| 模型类型 | 被测模型 / AI Judge |
| Provider | OpenAI Compatible / Ollama / Local |
| Base URL | API 地址（Ollama 默认 http://localhost:11434/v1） |
| API Key | 访问密钥；入库前加密存储 |
| 推理模型 | 自动分配更大 token 预算（默认 32768） |

---

## 技术架构

| 层 | 技术 |
|----|------|
| 前端 | React 18 · Vite 5 · Ant Design 5 · ECharts |
| 后端 | Fastify 5 · Prisma 5 · SQLite（WAL）· WebSocket |
| 引擎 | packages/core：模型调用、评分器、AI Judge、安全、沙箱、容器执行、隐藏测试、编排器、报告 |
| 工程 | pnpm monorepo（apps/web · apps/server · packages/*） |

### 目录结构

```
apps/web/        # React 前端
apps/server/     # Fastify 后端 + API + Prisma
packages/core/   # 评测引擎核心（orchestrator / judge / evaluators / scoring / execution / contracts）
packages/types/  # 共享类型
packages/utils/  # 工具函数
data/scenarios/  # 595 道可评测基准题（benchmark.json + 元数据 + CR2 备选题集；archive/ 为退役旧题归档）
data/java-libs/  # Java 题 JUnit 依赖 jar
scripts/         # 题库导入/导出脚本
docs/            # 规范文档（fixture-spec 等）
```

---

## 评测可靠性与高区分度方法

本版本将评测结果视为一组可审计证据，而不是简单地从历史结果中“取最高分”：

- 暂停恢复、重试和 Judge-only 补评按题目尝试链归并；题级主结果采用最后完成的尝试，若该行是环境错误或评分缺失则隔离披露，不回退到旧高分。
- 报告与排行榜从运行时冻结题集和每题最后完成的结果行重算，不以历史最高分或旧摘要替代。可运行 `pnpm --filter server run:verify-score <run-id> [database-url]` 只读核验题集哈希、历史行数、题级主结果数、各维度分和总分；旧数据库需要修复缓存摘要时显式追加 `--repair-summary`，工具会先创建数据库备份。
- Judge 只承担无法由确定性规则验证的语义原子项；输出使用精简 JSON、完整性校验和有界重试，失败时不会静默写成模型能力分。
- 模型请求支持硬时限、取消传播和孤儿请求清理；已保存答案可在执行环境恢复后重放，避免模型重复生成。
- 幻觉抵抗采用证据极性、来源边界和可验证声明；数学推理采用答案、推导、证明义务与证书检查分层计分，降低简单题和宽松 Judge 造成的满分堆积。
- 校准页面与审计接口保留评分来源、覆盖率、人工复核状态和可比性信息；跨模型对照默认不把格式失败等同于语义失败。

方法与实现说明见 [评测可靠性实现](docs/evaluation-reliability-implementation-2026-09-09.md)、[评测完整性修复](docs/evaluation-integrity-fixes-2026-09.md) 和 [幻觉抵抗与数学推理最终方法](docs/resistance-math-method-final-2026-09-12.md)。运行 `pnpm eval:methods-v2 -- --help` 查看冻结题包的导出、校验和评分命令；运行 `pnpm eval:inspect -- --help` 查看能力覆盖检查参数。两条命令均为离线工具，不调用模型、Judge 或生产数据库。

---

## 测试与 CI

评分、聚合、契约、执行隔离、Judge 完整性与校准均包含回归测试：

```bash
pnpm test   # vitest 运行 packages/**/*.test.ts
```

GitHub Actions 在 push / PR 时自动执行：pnpm install → prisma generate → pnpm test → pnpm build。

---

## 许可

MIT License · Copyright (c) 2026 ZhiXiu Contributors
