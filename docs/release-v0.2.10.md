# ZxBench v0.2.10 — question contracts and grading evidence

This release consolidates the October 7 math, tool, programming, safety and semantic-review repairs. The default catalogue remains 803 source questions and 920 execution instances. The question revisions and grading policies are explicit; successful completion of inference is no longer displayed as a passing grade.

## Changes

- [Math/tool contracts](math-tool-contract-review-2026-10-07.md): equivalent labels and field-level grading, exact compound-interest C=108.48, progressive content versus submission protocol, the conflicting CRT range contract, delivered artifacts, archive roots and visible scaling parameters.
- [Programming submission contracts](program-submission-review-2026-10-07.md): retain complete submitted modules and imports, preserve bilingual answer labels, test TypeScript candidates semantically, and repair C#/SQLite/Bash scaffolds. The four intentional correct-code traps retain their original meaning.
- [Safety contracts](safety-contract-review-2026-10-07.md): accept declared equivalent refusals and verified facts, disclose required tool arguments, and distinguish harmless read-only recovery from forbidden actions. Real red lines remain failures.
- [Bounded meaning review v2](semantic-meaning-review-v2.md): freeze the policy for new runs, route eligible textual criteria independently, guard exact facts and quote stance, and record skips, blocks, conflicts and review evidence. An inconclusive or malformed Judge response does not become a successful answer.
- Live monitoring uses the graded pass/fail outcome and restores saved progress after service reload.
- The current runtime fingerprint includes semantic-review sources and is checked by CI separately from historical frozen audit manifests.

## Upgrade and historical results

Install dependencies with the frozen lockfile, generate the Prisma client, build, and synchronize the bank using `pnpm bank:sync`. Verify it with `pnpm bank:check` and check the required Docker images using `pnpm runtime:check`. See the README for database initialization and startup commands.

The release does not contain a user database, model outputs, credentials or replacement historical manifests. Updating code and importing the bank do not automatically change saved scores. Historical regrading requires original frozen task meaning, sufficient original evidence and an explicit revision ledger. Revised prompts/scaffolds cannot be silently substituted into historical runs. An empty answer cannot be filled by regrading; task defects require a consistently applied exclusion policy or an explicitly authorized new attempt.

Semantic review v2 applies to newly frozen runs. Runs without that policy retain their earlier behavior. Exact actions, protected facts, format deductions and actual safety failures remain enforceable. Semantic guards reduce false grading but do not guarantee that every paraphrase or contradiction will be interpreted correctly.

## Verification

The release validation asset records build, regression, deployment and CI results for the released commit. Optional container tests skipped by the standard suite are reported separately; the standard suite does not establish complete Docker gold coverage for every multi-file project. No candidate-model or Judge calls are required by the release verification.
