# ZxBench · Local LLM Evaluation Platform

[中文文档](README.md) · English

> Run any large language model (local GGUF / Ollama / OpenAI-compatible API) through **516 benchmark questions** across 10 dimensions on a single machine — producing reproducible composite scores, dimension radar, leaderboards, AI deep-dive reports and cost-effectiveness analysis. Programming questions are **actually compiled and executed with hidden tests inside Docker containers**, so scores reflect real code behavior, not text similarity.

[![CI](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml)

## Highlights

- **10 capability dimensions**: programming, reasoning & math, safety & authority, deep CLI tasks, data extraction, agent workflow, instruction following, tool/CLI workflow, hallucination resistance, structured output.
- **516 evaluable benchmark questions**: difficulty-graded (easy/medium/hard/adversarial), version-controlled (per-question scenarioHash, versioned benchmark-meta.json).
- **Real code execution**: JS/TS/Python run in a subprocess sandbox; Go/Java/C/C++/Rust/PHP/C#/Bash/SQL run in Docker containers with real compile + hidden-test execution (ASan for memory errors, JUnit for Java, race detector for concurrency, SQLite for queries). The test_pass axis is the actual test pass rate — no keyword guessing.
- **no_bug traps**: some code is already correct; the model must recognize no-bug instead of forcing a fix (false fixes score 0).
- **Deterministic scoring + AI Judge dual channel**: rule-based evaluators score first; an AI Judge re-scores semantic items with coverage-aware weight handoff.
- **Composite score (difficulty-weighted + dimension-weighted)**: harder questions weigh more, dimensions weighted by importance.
- **Anti-tailspin**: hard caps on reasoning-token budget, a per-question hard time limit (300s default), fail-fast on limit.
- **Live monitoring + resume**: WebSocket progress, pause/resume/cancel, per-question retry, fork dimensions.
- **Reports & leaderboards**: dimension charts, AI deep-dive reports, model leaderboard, cost-effectiveness scatter.
- **Regression tests + CI**: 37 unit tests on scoring/aggregation/contract cores, GitHub Actions build+test.

---

## Questions & Real Execution (Key Design)

ZxBench programming questions do not judge code by keyword similarity — the model's fix is put into an isolated environment and truly compiled and tested:

| Language | Execution backend | Verification |
|----------|-------------------|--------------|
| JavaScript / TypeScript | subprocess sandbox (type annotations stripped) | hidden-test assertions |
| Python | subprocess sandbox | assert |
| Go | golang:1.21 container | go test (race detector for concurrency) |
| Java | eclipse-temurin:17-jdk-alpine container | javac + JUnit |
| C / C++ | gcc:13 container | -fsanitize=address for overflow/dangling |
| Rust | rust:1.75 container | rustc + assert (borrow error = compile failure) |
| PHP | php:8.2-cli container | assert (mbstring built-in) |
| C# | mono:6.12 container | compile + custom Assert |
| Bash | bash:5 container | assertion via exit code |
| SQL | node:22-alpine container | node:sqlite schema+seed+query+result-set diff (EXPLAIN plan check for perf) |

Beyond regular fix-the-bug questions, the programming dimension also includes:

- **no_bug traps**: correct code; model must answer NO_FIX_NEEDED with reasoning.
- **plan questions**: migration review / incident triage (zero-downtime column rename, p99 latency diagnosis), scored by step checklist, in the instruction-following dimension.
- **implementation questions**: complete a given signature (e.g. safeParseInt, Top-N query).

Every executable question ships a referenceSolution plus fixture (compile unit / dependency stubs / DB schema+seed), and passes a two-way gate: the bug version must fail, the reference solution must pass.

---

## Quick Start

### Requirements

- Node.js >= 22.13 (required by pnpm 11 and node:sqlite)
- pnpm >= 11
- **Docker** (required for containerized programming questions)

Images are pulled automatically on first run; pre-warm them with:

```bash
docker pull golang:1.21 eclipse-temurin:17-jdk-alpine gcc:13 rust:1.75 php:8.2-cli mono:6.12 bash:5 node:22-alpine
```

> The JUnit jars for Java questions are bundled under data/java-libs/ — no extra download needed.

### Install & Run

```bash
pnpm install
pnpm --filter server prisma:generate
cp apps/server/.env.example apps/server/.env
pnpm build

start.bat                 # Windows one-click with watchdog auto-restart
# or
pnpm --filter server start  # default port 3001
```

Open http://127.0.0.1:3001.

### Import / Export Benchmark

```bash
node scripts/seed-benchmark.mjs    # import into DB
node scripts/export-scenarios.mjs # export benchmark.json + meta
```

---

## How the Composite Score Works

### 10 Dimensions & Question Counts

| Dimension | Questions | Weight |
|-----------|-----------|--------|
| program | 92 | 0.20 |
| hallucination_resistance | 78 | 0.12 |
| reasoning_math | 34 | 0.12 |
| instruction_following | 42 | 0.12 |
| safety_authority | 50 | 0.10 |
| agent_workflow | 45 | 0.08 |
| tool_cli_workflow | 56 | 0.07 |
| data_extraction | 35 | 0.07 |
| cli_deep_tasks | 56 | 0.07 |
| structured_output | 28 | 0.05 |

### Three-step scoring chain

1. **Difficulty-weighted dimension average** (easy=1, medium=1.5, hard=2, adversarial=2.5).

```
dimension average = Σ(score x difficulty weight) / Σ(difficulty weight)
```

2. **Dimension-weighted total (composite score)**.

```
composite score = Σ(dimension average x dimension weight) / Σ(dimension weight)
```

3. **Deterministic + AI Judge dual channel**: per-dimension det/judge weights; unmeasured axes hand their weight to the Judge by coverage; without a Judge and coverage < 0.5, the total is discounted to 0.3x.

> **AI Judge retrieval caveat (hallucination resistance)**
> Hallucination resistance is now **AI-Judge-led** (semantic judgment), with rules as fallback only.
> However, citation questions (DOI/URL/ISBN/PMID) require web retrieval to verify that a reference truly exists,
> and the AI Judge is currently a plain Chat Completions call with **no retrieval capability**.
> When the Judge lacks retrieval, these questions are automatically flagged **human-review-required** for manual verification.
> Prefer an external API with web-search for the AI Judge; local judges inherit this limitation.

### Note on difficulty distribution

Difficulty labels are not uniformly distributed across dimensions: agent_workflow / cli_deep_tasks have 84-86% hard/adversarial questions, while reasoning_math / structured_output have only 32-36%. Cross-dimension score comparison should therefore be made with care — the same score sits on a different difficulty baseline in different dimensions.

In practice, model scores show no simple inverse correlation with difficulty labels: reasoning_math is relatively easy yet scores low (most models 48-71), while agent/CLI are hard yet score high (78-91). Real capability differences (weak math, strong workflow) dominate the effect. The difficulty distribution is kept as-is, disclosed here.


---

## Pages

1. **Dashboard** — global stats, dimension radar, distribution.

![Dashboard](docs/screenshots/dashboard.png)

2. **EvalCreate** — configure a run (single or multi-model).

![EvalCreate](docs/screenshots/eval-create.png)

3. **EvalLive** — real-time progress, pause/resume/cancel, retry, fork.

4. **EvalHistory** — list of runs.

![EvalHistory](docs/screenshots/eval-history.png)

5. **EvalDetail** — per-question detail, evidence, retry.

6. **Report / ReportList** — scores, radar, ranking, evidence composition, AI report.

![Reports](docs/screenshots/reports.png)
![Report](docs/screenshots/report.png)
![AI Report](docs/screenshots/report-ai.png)

7. **Leaderboard** — per-model ranking (latest run / best-across-runs).

![Leaderboard](docs/screenshots/leaderboard.png)

8. **Scenarios** — question management.

![Scenarios](docs/screenshots/scenarios.png)

9. **CompareModels** — multi-model comparison report.

![Compare](docs/screenshots/compare.png)

10. **ModelValue** — score vs token scatter.

![ModelValue](docs/screenshots/value.png)

11. **ModelConfig** — model & judge configuration.

![Settings](docs/screenshots/settings.png)

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 · Vite 5 · Ant Design 5 · ECharts |
| Backend | Fastify 5 · Prisma 5 · SQLite (WAL) · WebSocket |
| Engine | packages/core: model calling, evaluators, AI Judge, safety, sandbox, container execution, hidden tests, orchestrator, reports |
| Workspace | pnpm monorepo (apps/web · apps/server · packages/*) |

```
apps/web/        # React frontend
apps/server/     # Fastify backend + API + Prisma
packages/core/   # evaluation engine
packages/types/  # shared types
packages/utils/  # utilities
data/scenarios/  # 516 evaluable benchmark questions
data/java-libs/  # JUnit jars
scripts/         # import/export scripts
docs/            # specs (fixture-spec) & screenshots
```

---

## Tests & CI

```bash
pnpm test   # vitest across packages/**/*.test.ts
```

GitHub Actions runs pnpm install -> prisma generate -> pnpm test -> pnpm build on push / PR.

---

## License

MIT License · Copyright (c) 2026 ZhiXiu Contributors
