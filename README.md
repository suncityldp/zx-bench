# ZxBench · 本地大模型评测系统

[English](README.en.md) · 中文

> 在一台机器上，对任意大模型（本地 GGUF / Ollama / OpenAI 兼容 API）跑完 10 大维度、**516 道**基准题，产出可复现的综合分、维度雷达、排行榜、AI 深度报告与性价比分析。其中编程题在 **Docker 容器里真实编译并执行隐藏测试**，分数反映的是真实代码行为，而非「看起来像」的文本相似度。

[![CI](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml)

## 核心特性

- **10 大能力维度**：编程、推理数学、安全权限、深度 CLI、数据抽取、智能体工作流、指令遵循、工具/CLI、幻觉抵抗、结构化输出。
- **516 道可评测基准题**：难度分级（easy/medium/hard/adversarial）、带版本控制（每题 scenarioHash，题库 `benchmark-meta.json` 版本化）。
- **编程题真实执行**：JS/TS/Python 子进程沙箱；Go/Java/C/C++/Rust/PHP/C#/Bash/SQL 在 Docker 容器里**真实编译 + 运行隐藏测试**（ASan 检内存错误、JUnit 跑 Java、race detector 检并发、SQLite 跑查询），`test_pass` 轴 = 真实测试通过率——不再用关键词「猜」代码对不对。
- **no_bug 陷阱题**：部分代码本身正确，模型须识别「无 bug」而非强行修改，误修会扣分。
- **确定性评分 + AI Judge 双通道**：规则评分器先判，AI Judge 按维度权重补判语义项，覆盖率感知地「让渡」权重。
- **综合分（难度加权 + 维度加权）**：高难题权重更大、按维度重要度加权求和，避免「均分」被题量带偏。
- **反拖尾**：推理模型思考链硬上限、单题硬时限（默认 300s）、超限即判，不再无限升级 token 预算。
- **实时监控 + 断点续跑**：WebSocket 实时进度、暂停/恢复/取消、单题重试、fork 分叉维度。
- **报告与排行榜**：自动聚合维度图表、AI 深度报告、模型排行榜、模型性价比散点图。
- **回归测试 + CI**：评分/聚合/契约核心 37 个单元测试，GitHub Actions 自动构建+测试。

---

## 题目与真实执行（关键设计）

ZxBench 的编程题不是「模型输出一段代码、用关键词判断像不像答案」，而是**把模型的修复结果放进隔离环境里真的编译、真的跑测试**：

| 语言 | 执行后端 | 验证方式 |
|------|----------|----------|
| JavaScript / TypeScript | 子进程沙箱（类型注解自动剥离） | 隐藏测试断言 |
| Python | 子进程沙箱 | assert 断言 |
| Go | golang:1.21 容器 | go test（并发题开 -race） |
| Java | eclipse-temurin:17-jdk-alpine 容器 | javac + JUnit |
| C / C++ | gcc:13 容器 | -fsanitize=address 检内存越界/悬垂指针 |
| Rust | rust:1.75 容器 | rustc + assert（borrow 错误 = 编译失败） |
| PHP | php:8.2-cli 容器 | assert（内置 mbstring） |
| C# | mono:6.12 容器 | 编译 + 自定义 Assert |
| Bash | bash:5 容器 | 断言以退出码判定 |
| SQL | node:22-alpine 容器 | node:sqlite 建表+插数+查询+结果集比对（性能题用 EXPLAIN 计划检查） |

除常规「修复 bug」题外，编程维度还包含：

- **no_bug 陷阱题**：代码正确，模型须输出 `NO_FIX_NEEDED` 并说明原因；强行修复得 0 分。
- **plan 题**：方案评审 / 故障诊断（数据库零停机迁移、p99 延迟排查等），按步骤 checklist 评分，已归入指令遵循维度。
- **实现题**：给定签名与类型约束补全实现（如 safeParseInt、Top-N 查询）。

所有可执行题都附带 referenceSolution（正确解）与 fixture（编译单元 / 依赖桩 / 数据库 schema+seed），并通过「bug 版本必挂 + 正确解必过」的双向验证门后才入库。

---

## 快速开始

### 环境要求

- Node.js ≥ 22.13（pnpm 11 与内置 node:sqlite 需要）
- pnpm ≥ 11
- **Docker**（编程题容器执行必需）

首次评测前会自动拉取所需镜像；也可手动预热：

```bash
docker pull golang:1.21 eclipse-temurin:17-jdk-alpine gcc:13 rust:1.75 php:8.2-cli mono:6.12 bash:5 node:22-alpine
```

> Java 题所需的 JUnit jar 已内置在 data/java-libs/，随仓库分发，无需额外下载。

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
| program | 编程能力 | 92 | 0.20 |
| hallucination_resistance | 幻觉抵抗 | 78 | 0.12 |
| reasoning_math | 推理与数学 | 34 | 0.12 |
| instruction_following | 指令遵循 | 42 | 0.12 |
| safety_authority | 安全与权限 | 50 | 0.10 |
| agent_workflow | 智能体工作流 | 45 | 0.08 |
| tool_cli_workflow | 工具/CLI/工作流 | 56 | 0.07 |
| data_extraction | 数据抽取 | 35 | 0.07 |
| cli_deep_tasks | 深度命令行任务 | 56 | 0.07 |
| structured_output | 结构化输出 | 28 | 0.05 |

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

不过实测显示，模型分数与难度标签并无简单负相关：推理数学偏易却普遍低分（多数模型 48-71），智能体/CLI 偏难却普遍高分（78-91）。说明模型真实能力差异（数学弱、工作流强）比难度标签的影响更大。当前保持难度分布原样，仅在此披露。


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

> **AI Judge 检索能力提示（幻觉抵抗维度）**
> 幻觉抵抗维度已改为 **AI Judge 主导**（语义判断）评分，规则仅作兜底。
> 但 citation 类题目（要求给出 DOI/URL/ISBN/PMID 等可核实引用）的真伪需要联网检索验证，
> 而 AI Judge 当前是纯 Chat Completions 调用、**不具备检索能力**。当 Judge 无检索能力时，
> 这类题的引用真伪会**自动标记「需人工复核」**（humanReviewRequired），请用户事后核实。
> 建议 AI Judge 采用支持联网检索的外部 API；若用本地部署模型作 Judge，请注意该限制。

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
data/scenarios/  # 516 道可评测基准题（benchmark.json + 元数据 + CR2 备选题集）
data/java-libs/  # Java 题 JUnit 依赖 jar
scripts/         # 题库导入/导出脚本
docs/            # 规范文档（fixture-spec 等）
```

---

## 测试与 CI

评分/聚合/契约核心 37 个回归测试：

```bash
pnpm test   # vitest 运行 packages/**/*.test.ts
```

GitHub Actions 在 push / PR 时自动执行：pnpm install → prisma generate → pnpm test → pnpm build。

---

## 许可

MIT License · Copyright (c) 2026 ZhiXiu Contributors
