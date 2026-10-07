# Changelog

All notable changes to ZxBench are documented here.

## [0.2.10] — 2026-10-07

### Question contracts and grading evidence

- Correct math field/label comparisons and separate verifiable mathematical content from submission protocol; keep compound-interest C=108.48 exact and mark the conflicting CRT range contract explicitly.
- Repair tool delivery, reminder aliases, archive roots, scaling delta arguments and scoped workflow checkpoints; expose required tool parameters in future tasks.
- Preserve full unfenced programming modules, bilingual answer labels and Go imports. Require semantic TypeScript rejection rather than missing candidate declarations, and provide runnable C#/SQLite/Bash scaffolds.
- Preserve deliberate correct-code traps. Classify incompatible historical scaffolds and hidden-parameter tasks as benchmark defects without inventing answers or successful calls.
- Recognize equivalent safety refusals and verified facts while retaining wrong facts, contradictory statuses, forbidden actions and real red lines.
- Freeze bounded semantic review v2 for new runs, validate exact currency/date/identifier facts and quote stance, and persist review routes. Historical runs retain their frozen policy.
- Show graded pass/fail in completed live results and restore frozen progress after reload.
- Update the current runtime source fingerprint and verify it in CI. Preserve historical audit manifests and original answers; code upgrades do not automatically rescore stored results. See [release notes](docs/release-v0.2.10.md).

## [0.2.9] — 2026-10-02

### Deployment and question-bank synchronization

- Check released definitions at server startup and show the sync command when a new or upgraded database is incomplete or has stale hashes. Keep the API available for importing the bank.
- Include actionable sync instructions in missing-definition and hash-drift errors before model inference.
- Make default imports upsert-only, preserving unrelated definitions and historical runs. Verify persisted IDs, valid status and frozen hashes after import; fail on HTTP errors or incomplete persistence.
- Add `pnpm bank:sync`, read-only `pnpm bank:check`, and `pnpm runtime:check` for explicit Docker image contracts. Add deployment regression tests to CI.
- Initialize the configured SQLite parent directory and file before `pnpm db:push`, without replacing existing database content.
- Document database initialization, the required second-terminal import, upgrade checks, and Docker image readiness in both quick starts. Existing installations must still synchronize their local database; updating code alone does not import questions.
- Preserve the v0.2.8 question catalogue, scoring contracts, historical answers and frozen snapshots.

## [0.2.5] — 2026-09-30

### Default question-bank correction

- Make the adopted nine-model catalogue the default: 614 ordinary questions and 306 execution instances representing 189 migrated sources, for 803 source questions in total.
- Remove superseded original migration prompts and unrelated definitions from the active catalogue. Importing the released bank removes online definitions outside this catalogue while preserving historical runs and answers.
- Freeze exact released contracts, reject missing definitions/hash drift before inference, and use the same selector for preview, single runs and batches.
- Average migration instances within each original source before applying its difficulty/category/attack weight. Preserve historic frozen-run scoring and retain the newer selection filters and candidate Token metrics.

## [0.2.4] — 2026-09-29

### Scoring and reports

- Add optional semantic Judge review for strict execution-world final answers. It runs only after all other checks pass, preserves the literal score and audit evidence, and marks invalid Judge output for manual review.
- Correct the CLI-027 expected project output path.
- Publish the [nine-model semantic Judge rescore](docs/semantic-judge-nine-model-rescore-2026-09-29.md) and [latest targeted scores and token usage](docs/nine-model-latest-score-tokens-2026-09-29.md). These are saved-result comparisons; the published report does not overwrite historical model runs.

## [0.2.3] — 2026-09-28

### Updated questions and scoring

- Publish 60 structured-output questions and 189 Docker migration sources with 306 execution instances, with native task packs and reference checks.
- Repair Docker question wording, runtime budgets and termination records, multi-line replies, trace-based grading, safety classification, Git workspace setup, and script interpreter selection.
- Preserve historical run snapshots. Publishing this release does not update the online scenario database or a running evaluation; corrected prompts and budgets require targeted new model answers.
- Verify the workspace build, 69 related tests, and local Docker positive/negative probes. See [the question refresh note](docs/question-refresh-2026-09-28.md).

## [0.2.2] — 2026-09-26

### Current benchmark and evaluation reliability

- Update the released bank to **1.47.0**: 815 valid questions in 11 dimensions, including nine explicit-only development-shadow questions; a default run selects 806.
- Preserve frozen question packs and run constraints. Progressive four-part questions now carry their actual prior prompts and model answers in order, including during controlled replay.
- Distinguish model failures from execution-environment and Judge failures. Audit stored scores and rule/Judge conflicts, and keep runs with incomplete scoring off the leaderboard.
- Preflight the selected Judge before starting a run; improve batch monitoring and keep run-level token limits effective for each question.
- Publish the [five-model evaluation report](analysis/swift-five-model-report/Swift与五模型全维度测评报告-20260925.md) with figures, common-question methodology, and item-level format adjudications. Its 801-question comparison is a historical analysis, not the current default run.

### Hotfix

- Restore all 20 pre-existing multi-file long tasks to formal scope: benchmark 1.31.1 runs 620 questions, including 150 programming questions.
- Make `benchmark.json` the only released import catalogue. Development fixtures and historical CR2 subsets are no longer imported as formal questions.
- On upgrade, retire only accidentally imported bundled-history rows while preserving user-created custom questions and historical result rows.
- Bind official-run selection and dashboard counts to the released catalogue, and reject same-ID database definitions whose frozen content hash is out of sync.

## [0.2.1] — 2026-09-13

### Hotfix

- Restore the released **正式评测** flow: the 580 frozen, score-bearing public scenarios are now accepted; 20 explicitly marked multi-file development-shadow scenarios remain excluded from the main score.
- Normalize `goldVerifiedAt` before scenario hashing, so SQLite/Prisma date round-trips cannot falsely report a frozen definition as modified.
- Synchronize the local 600-scenario definition store without altering historical runs or result rows, and add API/contract regression coverage for the released flow.

## [0.2.0] — 2026-09-13

### Highlights

- Publish benchmark 1.30.0: 600 active definitions across 10 dimensions, with 78 retired scenarios retained as versioned archive material.
- Add five prospective-only, deterministic challenge questions for hallucination resistance and mathematical reasoning. They use strict JSON contracts and no Judge calls.
- Complete the trusted single-file programming migration: 107 repair scenarios, 345 frozen verification IDs, and two executable-evidence PR scenarios.
- Expand and freeze the data-extraction suite at 56 typed JSON-contract scenarios.
- Repair real-time monitor card contrast in dark mode.

### Reliability boundaries

- Multi-file `project_repair` scenarios remain explicit-only development shadow tasks. JavaScript, Python, and Go maintainer risk samples have replayed positive gold; C#, Rust, and SQL remain pending and do not affect official scores.
- `MC2-004-R1` is a redesigned development candidate, not part of benchmark 1.30.0 or historical score comparisons.
- Complete fenced JSON is no longer misclassified as truncated; genuinely unclosed fences remain rejected.

### Validation

- Automated unit and contract regression tests cover the release changes. Container-backed gold replay verifies the initial JavaScript, Python, and Go multi-file risk sample.
