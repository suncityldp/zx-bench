# ZxBench · Local LLM Evaluation Platform

[中文文档](README.md) · English

> Run any large language model (local GGUF / Ollama / OpenAI-compatible API) through **595 benchmark questions** across 10 dimensions (673 total bank size; 78 retired questions archived under data/scenarios/archive/) on a single machine — producing reproducible composite scores, dimension radar, leaderboards, AI deep-dive reports and cost-effectiveness analysis. Programming questions are **actually compiled and executed with hidden tests inside Docker containers**, so scores reflect real code behavior, not text similarity.

[![CI](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml)

## Highlights

- **10 capability dimensions**: programming, reasoning & math, safety & authority, deep CLI tasks, data extraction, agent workflow, instruction following, tool/CLI workflow, hallucination resistance, structured output.
- **595 evaluable benchmark questions** (673 lifetime bank, 78 retired archived): difficulty-graded (easy/medium/hard/adversarial), version-controlled (per-question scenarioHash, versioned benchmark-meta.json).
- **Real code execution**: JS/TS/Python use containers by default; other supported languages execute according to their fixtures. Missing behavioral tests remain unmeasured. Memory/race checks are opt-in per fixture, not universally enabled.
- **no_bug traps**: some code is already correct; the model must recognize no-bug instead of forcing a fix (false fixes score 0).
- **Deterministic scoring + AI Judge dual channel**: rule-based evaluators score first; an AI Judge re-scores semantic items with coverage-aware weight handoff.
- **Composite score (difficulty-weighted + dimension-weighted)**: harder questions weigh more, dimensions weighted by importance.
- **Anti-tailspin**: hard caps on reasoning-token budget, a per-question hard time limit (300s default), fail-fast on limit.
- **Live monitoring + resume**: WebSocket progress, pause/resume/cancel, per-question retry, fork dimensions.
- **Reports & leaderboards**: dimension charts, AI deep-dive reports, model leaderboard, cost-effectiveness scatter.
- **Regression tests + CI**: automated regression coverage for scoring, aggregation, gold answers and contracts, with GitHub Actions build+test.

---

## Questions & Real Execution (Key Design)

ZxBench programming questions do not judge code by keyword similarity — the model's fix is put into an isolated environment and truly compiled and tested:

| Language | Execution backend | Verification |
|----------|-------------------|--------------|
| JavaScript / TypeScript | node:20-alpine container | assertions + completion evidence; separate strict type tests |
| Python | python:3.12-alpine container | syntax check, assert + completion evidence |
| Go | zxbench/go:1.21-gcc | compile test binary, run fixed test inventory; optional race detector |
| Java | maven:3.9-eclipse-temurin-17-alpine | javac + JUnit; complete report/exit validation |
| C / C++ | zxbench/cpp:gcc13-valgrind | assertions; optional fixture.memoryCheck=valgrind |
| Rust | rust:1.75-alpine | rustc + assert; distinct compile/runtime failures |
| PHP | php:8.2-cli-alpine | explicitly enabled assertions |
| C# | .NET SDK 8.0-alpine | dotnet build + custom Assert |
| Bash | bash:5 | -e/pipefail, syntax check + completion evidence |
| SQL | node:22-alpine container | node:sqlite schema+seed+query+result-set diff (EXPLAIN plan check for perf) |

Beyond regular fix-the-bug questions, the programming dimension also includes:

- **no_bug traps**: correct code; model must answer NO_FIX_NEEDED with reasoning.
- **plan questions**: migration review / incident triage (zero-downtime column rename, p99 latency diagnosis), scored by step checklist, in the instruction-following dimension.
- **implementation questions**: complete a given signature (e.g. safeParseInt, Top-N query).

Run `pnpm test:containers` for real positive/negative controls across 12 languages. This verifies runners, not every historical question's gold answer: reference-solution/fixture coverage remains incomplete. Containers default to non-root, no network and a read-only workspace; some builds require writable workspaces. The root filesystem is not universally read-only, and completion markers do not provide an anti-tampering boundary.

### 2026-09-12 execution and review update

Frozen 171 current contracts with `code_repair@3.4.0`, `instruction_checklist_v5` and `llm_judge@2.0.0`. Structural relations replace keyword proxies in targeted instruction questions. PR review requires strict JSON, file binding and original diff evidence; unmatched findings or Judge failures require review. Historical scores are not overwritten or silently migrated. See [verification and limitations](docs/execution-instruction-pr-v2.md).

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

### Reviewed data-extraction v3 bank

The data-extraction dimension now contains 56 reviewed questions: the original 35 were aligned with their scored fields and 21 medium/hard/adversarial cases were added. `json_atomic_v3` freezes the complete expected JSON, required leaf paths, every container/field type, JSON-only output, and a no-extra-fields policy. It is fully deterministic and does not call a Judge. See [the v3 review record](docs/data-extraction-v3-review.md).

---

## How the Composite Score Works

### 10 Dimensions & Question Counts

| Dimension | Questions | Weight |
|-----------|-----------|--------|
| program | 150 | 0.20 |
| hallucination_resistance | 78 | 0.12 |
| reasoning_math | 34 | 0.12 |
| instruction_following | 42 | 0.12 |
| safety_authority | 50 | 0.10 |
| agent_workflow | 45 | 0.08 |
| tool_cli_workflow | 56 | 0.07 |
| data_extraction | 56 | 0.07 |
| cli_deep_tasks | 56 | 0.07 |
| structured_output | 28 | 0.05 |
| **Total** | **595** | |

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

> **Hallucination grading scope**
> Fully parsed facts are checked offline; prose requires criterion-based semantic judging. Missing or failed semantic grading preserves the answer and excludes it from aggregates. Checksum validity and material attribution do not prove external publication existence. Actual external citations remain reviewable; choosing a model advertised with search does not add tools to the current Chat Completions call.

### Note on difficulty distribution

Difficulty labels are not uniformly distributed across dimensions: agent_workflow / cli_deep_tasks have 84-86% hard/adversarial questions, while reasoning_math / structured_output have only 32-36%. Cross-dimension score comparison should therefore be made with care — the same score sits on a different difficulty baseline in different dimensions.

Historical math score ranges from before issue #7 require revalidation; they must not be used to infer capability differences across dimensions.


---

## Reference-answer correction (issue #7)

All 34 math questions now use 3.2.0 / exact_answer_v4; all 78 current hallucination questions were individually reviewed at 5.0.0 / hallucination_v5. Fully parsed facts are checked offline; semantic answers require a successful criterion-based Judge. Unavailable semantic grading is excluded from aggregates, not scored as a model failure. Obsolete results remain preserved and non-comparable. See [review and validation](docs/reviewed-question-bank-v5.md). Preview `node scripts/sync-reviewed-question-contracts.mjs <database>`; add `--apply` for an automatic backup and transactional definition-only update.

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
data/scenarios/  # 595 evaluable benchmark questions (+ archive/ retired set)
data/java-libs/  # JUnit jars
scripts/         # import/export scripts
docs/            # specs (fixture-spec) & screenshots
```

---

## Evaluation reliability and discriminative methods

This release treats an evaluation as an auditable evidence trail instead of selecting the highest score from historical rows:

- Resume, retry, and Judge-only attempts are linked per question; the primary result uses the latest valid attempt, while environment errors and missing grades remain visible.
- The Judge is limited to semantic atomic claims that deterministic checks cannot verify. Compact JSON, integrity validation, and bounded retry prevent malformed verdicts from silently becoming capability scores.
- Model calls propagate cancellation, enforce hard deadlines, and clean up orphan requests. Saved answers can be replayed after an execution environment recovers without regenerating model output.
- Hallucination resistance separates evidence polarity, source boundaries, and verifiable claims. Math separates final answers, derivations, proof obligations, and certificates to reduce ceiling effects from easy items or permissive judging.
- Calibration UI and audit APIs expose grading provenance, coverage, human-review state, and comparability. Cross-model comparisons do not equate formatting failures with semantic failures by default.

See [evaluation reliability implementation](docs/evaluation-reliability-implementation-2026-09-09.md), [evaluation integrity fixes](docs/evaluation-integrity-fixes-2026-09.md), and the [final hallucination/math method](docs/resistance-math-method-final-2026-09-12.md). Run `pnpm eval:methods-v2 -- --help` for frozen-pack export, verification, and grading commands, or `pnpm eval:inspect -- --help` for capability-inspection parameters. Both tools are offline and make no model, Judge, or production-database calls.

---

## Tests & CI

```bash
pnpm test   # vitest across packages/**/*.test.ts
```

GitHub Actions runs pnpm install -> prisma generate -> pnpm test -> pnpm build on push / PR.

---

## License

MIT License · Copyright (c) 2026 ZhiXiu Contributors
