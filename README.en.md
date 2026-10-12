# ZxBench · Local LLM Evaluation Platform

[中文](README.md) · English

[![CI](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/suncityldp/zx-bench/actions/workflows/ci.yml)

ZxBench is a locally deployed LLM evaluation platform with Docker execution, deterministic scoring, optional AI Judge, live monitoring, frozen runs, reports and leaderboards. Application **v0.2.11** uses bank **1.60.0**, with **803 source questions and 920 execution instances**: 614 ordinary questions and 306 execution instances for 189 migrated sources, grouped by source for scoring.

This release adds selective image preparation, image preflight before generation, automatic local configuration and deployment acceptance. An agent can follow the steps below without a model API key or candidate/Judge requests. [Release notes](docs/release-v0.2.11.md)

## Deployment: follow these steps in order

Run every `pnpm` command from the repository root. Use a separate directory for a new deployment; use the upgrade procedure below for an existing installation.

### 1. Check prerequisites and obtain the code

| Dependency | Requirement | Check |
| --- | --- | --- |
| Git | Access to this repository | `git --version` |
| Node.js / npm | Node.js ≥22.13; a supported LTS is recommended | `node --version`, `npm --version` |
| pnpm | Pin to 11.21.0 from `packageManager` | `pnpm --version` |
| Docker | Accessible Linux engine for execution tasks; frozen images are verified for linux/amd64 | `docker version`, `docker info` |
| Image store | Frozen OCI index IDs require a containerd image store | `docker info --format '{{json .DriverStatus}}'` |

If Node.js or Docker is missing, use the host's package manager and official installation instructions: [Node.js](https://nodejs.org/en/download), [Docker](https://docs.docker.com/get-started/get-docker/). Installation privileges, WSL/virtualization and host restarts are prerequisites; report a specific blocker instead of skipping the check and claiming success. If pnpm is missing or differs from the pinned version:

```sh
npm install --global pnpm@11.21.0
```

```sh
git clone https://github.com/suncityldp/zx-bench.git
cd zx-bench
git rev-parse HEAD
pnpm --version
```

Start Docker before checking it. Docker Desktop on Windows must use Linux containers. For `IMAGE_STORE_IDENTITY`, use a compatible containerd store as explained in the [Docker documentation](https://docs.docker.com/desktop/features/containerd/). Switching stores hides images and containers in the inactive store; the preparation tool never changes this global setting. Do not delete images, disable frozen-ID checks or rewrite the bank to hide an installation error.

### 2. Install, configure, initialize and build

```sh
pnpm install --frozen-lockfile
pnpm setup:env
pnpm --filter server prisma:generate
pnpm db:push
pnpm build
```

`setup:env` creates `apps/server/.env` with port 3001, loopback binding, the SQLite URL and a random encryption key. It never prints the key or overwrites an existing file. The default database is **`apps/data/zxbench.db`**, because `DATABASE_URL` is resolved relative to `apps/server/prisma`. Initialization preserves an existing database. Keep `.env` and the database private, and preserve the encryption key after model settings have been saved.

Success means every command exits with code 0 and the Prisma client, database tables and frontend/backend `dist` outputs exist. Stop at a failing step, fix the original error and retry; do not serve an old build.

For a custom port, use `pnpm setup:env --port 31001` when creating the file, or edit `PORT` in an existing configuration. Set `BASE_URL` for the online checks: `$env:BASE_URL='http://127.0.0.1:31001'` in PowerShell or `export BASE_URL=http://127.0.0.1:31001` in a POSIX shell.

### 3. Start the service and wait for health

Foreground command:

```sh
pnpm --filter server start
```

This is a long-running process. Agents can start it in the background and proceed to step 4, retaining its PID and logs. Do not start a duplicate of a healthy service running the same version.

Windows PowerShell:

```powershell
$deploymentRoot = (Get-Location).Path
New-Item -ItemType Directory -Path logs -Force | Out-Null
$serverProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'dist/index.js' -WorkingDirectory (Join-Path $deploymentRoot 'apps/server') -RedirectStandardOutput (Join-Path $deploymentRoot 'logs/server.out.log') -RedirectStandardError (Join-Path $deploymentRoot 'logs/server.err.log') -WindowStyle Hidden -PassThru
$serverProcess.Id | Set-Content logs/server.pid
```

macOS / Linux shell:

```sh
mkdir -p logs
(cd apps/server && exec node dist/index.js) >logs/server.out.log 2>logs/server.err.log &
echo $! > logs/server.pid
```

Poll `GET http://127.0.0.1:3001/api/health` for up to 60 seconds. Require HTTP 200, `status: "ok"` and `version: "0.2.11"`. Use `curl.exe -fsS http://127.0.0.1:3001/api/health` on Windows, or `curl -fsS` elsewhere. On failure, inspect `logs/server.err.log` and `logs/server.out.log`. Identify the owner of a conflicting port before stopping anything; do not kill another deployment or user process. The backend serves the built frontend; no separate Vite process is needed.

### 4. Sync and verify the released bank

Keep the backend running and execute these commands in another terminal or in the agent session after background startup:

```sh
pnpm bank:sync
pnpm bank:check
```

Require exit code 0 and **zero failures, missing/invalid definitions and hash mismatches**. The default import upserts release definitions and preserves unrelated questions, historical runs and answers. Do not use `--reset` for deployment. `Released benchmark database incomplete` means this step remains incomplete; code or JSON updates do not synchronize SQLite automatically.

### 5. Prepare only missing images

For all released questions:

```sh
pnpm runtime:prepare --check
pnpm runtime:prepare
pnpm runtime:check
```

The first command is a read-only plan. The second skips ready images, pulls public Python/Node/GCC images by frozen digest, verifies them before restoring the required tags, and downloads custom images as separate release assets. Archives are hashed and size-checked before `docker load`; actual image IDs are verified afterward. Verified archives are cached in `tmp/runtime`. **No complete image bundle, historical-tag search or private Harbor account is required.**

Archive downloads honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` and their lowercase forms. Docker pulls use the engine's own proxy settings. The tool does not print proxy URLs/credentials or disable TLS verification.

For a smaller evaluation, prepare its actual scope. Selection flags can be repeated:

```sh
pnpm runtime:prepare --dimension cli_deep_tasks --check
pnpm runtime:prepare --dimension cli_deep_tasks
pnpm runtime:prepare --scenario CLI-CN-002-DOCKER
pnpm runtime:prepare --image python:3.12-alpine
```

Repeat `runtime:prepare --check` with the same selection and require every entry to be `[skip] ... ready`. A full-bank `runtime:check` can still report missing images outside that scope. The separate Python archive is about 18 MiB; GCC is about 474 MiB and Java about 281 MiB, needed only for their corresponding tasks.

For offline installation, place the selected custom-image release assets in one directory and use `pnpm runtime:prepare --cache-dir /path/to/archives`. Public Python/Node/GCC images are not duplicated in the release: prepare their frozen digests on a connected machine and export the needed images with `runtime:export`. On the offline host verify the supplied SHA-256, then run `docker image load --input /path/to/python.tar` and repeat for the other needed public images. Preparation then skips ready public images and reuses the custom archives. A cache directory alone does not disable online pulls of missing public images.

```sh
# Connected machine, after verifying the frozen ID:
pnpm runtime:export --image python:3.12-alpine --output /path/to/transfer/python.tar
```

Do not edit the manifest or checksum values. See the [runtime manifest](docker/execution-images/runtime.json) for images, sizes, IDs and URLs, and [Docker troubleshooting](docs/docker-deployment-troubleshooting.md) for recovery.

These commands cover **explicit** question-bank image dependencies. Language runtimes embedded in graders, network dependencies and filesystem mounts still need verification for the actual tasks; preparation is not proof that every language test has run. Explicit image contracts are checked before new generation; missing or mismatched IDs pause evaluation before a model request. Existing environment-error results are not automatically rescored.

### 6. Verify deployment

```sh
pnpm deploy:check
```

Require exit code 0, `ready: true`, the correct version, `frontend: "ready"` and zero bank missing/hash mismatches. The checker reads health/version APIs, the homepage and JavaScript assets, and the online bank. It makes no writes or model requests (`modelRequests: 0`). Execution image readiness is established separately by step 5 for the intended scope.

Open <http://127.0.0.1:3001>. When handing off deployment, report the actual commit, service URL/PID, bank verification, image scope and unresolved dependencies. A running process alone is not completion. Add model settings afterward according to the user's choice; connectivity tests, Judge preflight and evaluation invoke models and are outside deployment acceptance.

## Upgrade an existing installation

1. Pause evaluations and stop this deployment's service. Back up the SQLite file from the actual `DATABASE_URL`, remaining WAL/SHM files and `apps/server/.env`. Do not stop unrelated services.
2. In a clean checkout run `git pull --ff-only`, then repeat step 2. Preserve local changes instead of using `git reset --hard`; `setup:env` preserves configuration and keys.
3. Restart, verify the new health version, and run `bank:sync`, `bank:check`, `runtime:prepare` for the intended scope, and `deploy:check`.

Updating code, the bank or images does not rescore saved answers or replace the frozen pack of an existing run. [Historical regrading](docs/release-v0.2.10.md) · [Saved programming-answer recovery](docs/docker-readiness-and-saved-answer-recovery.md)

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
