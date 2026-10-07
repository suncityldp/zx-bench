# Programming submission and scaffold corrections

Policy: `program-submission-contracts-20261007-v1`. This revision updates 15 question definitions. It does not change stored answers, frozen run manifests, or historical scores. The original and revised hashes are recorded in `data/scenarios/program-revision-manifest.json`.

## Submission parsing

The old heuristic could retain a second bilingual answer label or discard submitted imports, sibling type declarations, and outer classes. The scorer now removes conventional leading labels and keeps an unfenced submitted module together. Existing code-fence, patch-quality, and scope weights remain unchanged; passing behavioral tests alone does not imply a perfect score.

Go imports are moved into the trusted driver's header, ahead of its declarations. TypeScript negative cases require a compiling candidate and a semantic type rejection in the test; undefined names and unrelated candidate compilation errors do not earn negative-test credit.

`CP-L3-TS-003` explicitly accepts a complete source or the single `ExtractResponse` alias. The latter replaces only that named declaration in the original source. Execution and diff/scope checks use the resulting source; evidence records the materialization, while the submitted text remains intact. Other questions do not receive inferred or synthesized repairs.

Ten questions now make their source submission contracts explicit: `CP-L1-JS-001`, `CP-L2-TD-GO-001`, `CP-L3-PY-010`, `CP-L3-PY-011`, `CP-L3-JV-005`, `CP-L3-CS-004`, `CP-L3-TS-003`, `CP-L3-TS-007`, `CP-L2-CC-001`, and `CP-L3-CC-003`.

Two further contracts clarify existing behavior: `CP-L1-PY-004` filters negative inputs before squaring; `CP-L3-AW-JS-006` uses ordinary JSON values and the actual `JSON.stringify` key, including property insertion order. Their false-premise review format is retained.

## Project scaffolds

- `CP-L4-CS-001`: replace the incomplete entrypoint with callable endpoints, supply the missing model namespace and the options constructor required by the published context interface, and respect injected SQLite connections/interceptors. Replace the SQL Server-only retry requirement with a SQLite execution strategy for BUSY/LOCKED errors. Test success after transient failures, a maximum of three retries, rejection of permanent failures, and a 30-second command timeout. Accept the standard EF Core retry-limit exception wrapper.
- `CP-L4-CS-002`: supply complete endpoints and context constructors so the original application can compile and start. Publish `/events/count` and response contracts. The test factory uses public `AppDbContext` as an assembly marker, avoiding an undeclared requirement to expose top-level `Program`. The intended DI, transaction, tracking, and monitoring bugs remain for the model to fix.
- `CP-L4-SH-001`: use a Bash 5 compatibility image that supplies `/bin/bash` alongside `/usr/local/bin/bash`. The image can be built from a cached base without network access; candidate execution remains isolated.

## Deliberate correct-code traps

`PR-ELITE-001`, `PR-ELITE-002`, `PR-ELITE-004`, and `PR-ELITE-005` explicitly have `isCorrectCodeTrap: true` and `expectedVerdict: no_bug`. Their prompts ask for a repair intentionally. The prompt/source fingerprints were stable through 55 inspected historical benchmark commits. Their definitions are unchanged by this revision, including the misleading queue-clearing comment in `PR-ELITE-005`.

These tasks measure recognition of an incorrect repair premise. The `no_bug` path remains a rule-based classification, not execution-based certification of arbitrary code correctness. Trap intent alone does not prove every scoring heuristic is ideal; it does mean that the repair wording alone is insufficient grounds to erase the trap or award a model full credit.

## Validation and historical treatment

Core build and regression tests pass. Saved-answer diagnostics show that context-preserving extraction allows seven affected submissions to pass their existing behavioral tests; another TypeScript submission still fails because it uses a type as a value. Incorrect sorting and mapped-type controls remain rejected. Both C# scaffolds compile; a real API request verifies the public assembly marker and count route, and an independent SQLite strategy passes the retry/timeout checks. The Bash path and required utilities are verified in the compatibility image.

These diagnostics are not replacement historical scores. Any later rescoring must use original answers and frozen task definitions, identify which parsing corrections apply without changing task meaning, and distinguish scaffold defects from model failures. A revised prompt or scaffold must not be silently substituted into a historical run. No additional model evaluation is launched by this change.
