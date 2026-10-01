# ZxBench · Local LLM Evaluation Platform

[中文](README.md) · English

[![CI](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml)

ZxBench is a local evaluation platform with Docker execution, rule scoring, optional AI Judge, live monitoring, frozen runs, reports and leaderboards. The released bank **1.60.0 / v0.2.6** defaults to the adopted nine-model question set: **803 source questions**, comprising **614 ordinary questions + 306 execution instances for 189 migrated sources**. The 920 execution instances are grouped by source for scoring.

Recent updates move execution-oriented questions in five dimensions toward resettable Docker task packs and improve frozen question packs, progressive multi-part context, execution evidence, and score audits. **v0.2.4** also adds optional semantic Judge review of strict execution-task final answers. It is considered only after the other checks pass, preserves the literal rule score and audit trail, and sends invalid Judge output to manual review.

**v0.2.6** repairs workflow task contracts, repeated read verification, and requested `ANSWER/SAY` final-answer parsing. All 87 agent workflow instances use objective checkpoints; failed final delivery is capped at 40 and safety violations score 0. See the [repair and validation notes](docs/workflow-repair-2026-10-01.md).

## Quick start

Requires Node.js ≥22.13 and pnpm ≥11. Programming and Docker execution tasks also require a running Docker installation and the local images specified by the tasks. A missing image or unavailable daemon is an environment issue, not evidence of model failure.

```bash
pnpm install
pnpm --filter server prisma:generate
# Copy apps/server/.env.example to apps/server/.env and configure as needed
pnpm build
pnpm --filter server start
```

Workflow skill tasks require the frozen PyYAML image. Run `pnpm runtime:workflow` to download the v0.2.6 image asset and verify both archive SHA-256 and Docker image ID. For offline installation use `pnpm runtime:workflow --archive /path/to/image.tar.gz`. The image targets Linux amd64; Docker Desktop on Windows must use Linux containers.

Open <http://127.0.0.1:3001>. Windows users can also use `start.bat`; use the pnpm commands on macOS/Linux. On first use and after bank updates, run `node scripts/seed-benchmark.mjs` to import `data/scenarios/benchmark.json`. Importing removes online question definitions outside this release and preserves historical runs and answers. New runs select released IDs and content hashes and reject same-ID database drift. **Updating GitHub does not update an online database or alter a running evaluation's frozen questions**; see the [bank update note](docs/question-refresh-2026-09-28.md) for publication and sync details.

## Question bank and scoring

The table distinguishes source questions from execution instances in the default adopted release. Dimension/difficulty filters and explicit released-ID selections can reduce the scope.

| Dimension | Source questions | Execution instances | Weight |
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
| **Total** | **803** | **920** | **1.00** |

Questions are weighted by difficulty (easy 1, medium 1.5, hard 2, adversarial 2.5); `long_task_*` programming questions have an explicit **3.0** override. Migration instances are first averaged within each original source using that source’s original weight. Scores are then averaged within dimensions and then combined using the table weights. Rule graders verify deterministic conditions; an AI Judge can handle question-specific semantic checks. Environment errors, model mistakes, Judge failures, and rule/Judge conflicts have separate evidence. Runs with `scoringComplete=false` stay off the leaderboard. Retries use the latest eligible result in an attempt chain. Totals from different bank versions, selections, or run conditions are not directly comparable.

Exact-answer math questions also record `content_accuracy` when substance can be verified separately from `ANSWER:` or other format requirements. This diagnostic **does not affect the composite score**; format violations still incur the official penalty. It is available only when the content is independently checkable and the question hash matches.

## What Docker migration adds to execution tests

The [September bank update](docs/question-refresh-2026-09-28.md) provides **306 Docker execution instances for 189 still-valid source questions**. A source question can have several initial states or failure branches, so 306 is an instance count, not 306 additional official source questions. The migration covers deep CLI, tool/CLI workflow, agent workflow, multi-turn tool loops, and related safety and authority cases; original questions and historical results remain available. Development tasks retain `developmentShadow` marking or sit in a pilot track. **Passing a reference solution does not promote them into official scores.**

- **Execute actions and inspect outcomes.** CLI/script tasks run candidate scripts inside isolated containers and check stdout, output files, and Git workspace state. Tool and agent tasks use resettable local simulated worlds and score tool traces, state transitions, final state, and forbidden side effects.
- **Probe long workflows and recovery.** Cases include prerequisite reads, permission checks, partial success, timeouts, and lost responses. After partial email delivery, an agent must recheck state and send only to remaining recipients. After a debit commits but its response is lost, it must query status rather than retry with a new key. Email and money are synthetic local state, never real external operations.
- **Keep a reviewable contract and evidence.** Task packs fingerprint the question, executor, verifier, and reference script. Reference actions and core wrong examples check grading boundaries. A changed question, environment, or execution contract requires a new answer; a scoring-only change can be regraded offline only when the saved evidence is sufficient. Budgets, termination causes, and environment errors are recorded separately.

The mapping and task packs live in `data/scenarios/benchmark-release.json` and `data/execution/tasks/`; see [execution task governance](docs/execution-task-governance.md) for verification commands and evidence rules. Required images must be prepared locally. Reference and negative checks cover key rules, but do not prove acceptance of every equivalent solution or stable discrimination between models.

## Progressive questions: context and partial credit

A progressive problem is split into **four related parts**, each sent as a separate model request. A later part receives only the frozen prompts and the model's **fully committed answer items** from earlier parts in the same group. Hidden reasoning, gold answers, scores, and correctness feedback are not passed forward. A wrong or incomplete earlier answer does not block the next part, and a new group starts with fresh context. Retry handling checks for existing later answers so attempts are not spliced into one conversation.

A part can submit structured items incrementally. The last complete, valid record for an item is used. A timeout or truncation preserves previously committed and verified items; an incomplete tail cannot overwrite one. Infrastructure and run interruptions are marked separately. Part values and budgets are frozen in the paper, while reports show partial credit and termination causes. This design tests whether a model can carry its own earlier conclusions forward, continue reasoning, and submit useful work within a budget. **Increasing assigned points do not establish that later parts are empirically harder**; see the [progressive exam record](docs/progressive-exam-2026-09-14.md) for the pilot and its limits.

## Long programming tasks and engineering ability

The programming dimension includes single-file repairs, no-bug traps, and **20 multi-file `long_task_*` project tasks**: eight debugging, two implementation, and ten refactoring. Long tasks require the model to understand existing file relationships, submit complete contents labeled by path, and maintain context across multiple changes. The `project_repair` grader materializes the replacements in an isolated workspace, adds model-hidden test files, and runs tests. It also scores API stability, static signals, output completeness, and change scope. Reports show a separate long-task subscore and failure analysis rather than burying it in the overall programming mean.

Single-file `code_repair@4.14.0` has 107 repair questions and 345 frozen formal test IDs. Execution uses resource-limited containers or bounded compiler processes; expected values stay with the control side. Positive-gold coverage remains incomplete for some multi-file tasks. Container execution and passing tests do not certify arbitrary repository semantics or resistance to malicious code. See the [release gate and limitations](docs/lightweight-release-gate.md).

## Running, verifying, and reporting

- Create a single-model run or a batch of up to eight distinct models, each with an independent run. Question concurrency is 1–4, default 4.
- Reasoning models can use a larger generation budget, reasoning cap, and per-question deadline. Run-level `Max Tokens` is a hard request cap; question-level constraints can only lower it. Compare results alongside server context/output limits and timeout evidence.
- Live monitoring supports pause, resume, cancel, and question retry. Reports and leaderboards expose dimension scores and evidence; batch monitoring lets you switch between models.
- Run creation preflights the selected Judge. Frozen runs support read-only audits before intentional rescoring. Use `pnpm --filter server run:verify-score <run-id> [database-url]` to check the frozen bank, primary question results, dimension scores, and total without writes. Use `--repair-summary` only when repairing an old cached summary; it backs up the database first.
- `pnpm test` runs regression tests; `pnpm test:containers` runs Docker positive/negative checks; `pnpm build` verifies both builds. CI installs dependencies, generates Prisma, builds, and tests on push/PR.

For methods and limitations, see [scoring integrity and release gates](docs/scoring-integrity.md) and [evaluation reliability](docs/evaluation-reliability-implementation-2026-09-09.md).

## Published evaluations and results

The [nine-model semantic review](docs/semantic-judge-nine-model-rescore-2026-09-29.md) and [latest targeted scores and token usage](docs/nine-model-latest-score-tokens-2026-09-29.md) use saved answers for the same **803 source questions**; the 189 Docker migration sources are represented by 306 execution instances. Migration evidence includes development and pilot tracks, so these nine-model comparisons **do not directly replace the official leaderboard** or overwrite historical runs. These reports are in Chinese.

The [five-model evaluation report (2026-09-25)](analysis/swift-five-model-report/Swift与五模型全维度测评报告-20260925.md) compares Swift, GSQ-RCO, NVFP4, Bonsai-2 Q1, and ByteShape on **801 shared questions across ten dimensions**. It includes rerun progressive questions, token use, alternative scoring, figures, and item-level format adjudications. This is an earlier historical analysis, not the current bank or a hardware-normalized speed benchmark. [Download the PDF](output/pdf/Swift与五模型全维度测评报告-20260925.pdf) · [Open the portable HTML](analysis/swift-five-model-report/Swift与五模型全维度测评报告-单文件.html)

## Repository layout

```text
apps/web/        React frontend
apps/server/     Fastify API, Prisma, WebSocket
packages/core/   Model calling, execution, scoring, reports
packages/types/  Shared types
data/scenarios/  Current bank, metadata, and archives
data/execution/  Docker task packs, migration map, and evidence
scripts/         Bank import, export, and audit tools
docs/            Methods and update records
analysis/swift-five-model-report/  Five-model report and review data
```

MIT License · Copyright (c) 2026 ZhiXiu Contributors
