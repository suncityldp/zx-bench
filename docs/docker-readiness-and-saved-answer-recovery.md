# Docker readiness and saved-answer recovery

Docker Desktop launch is not readiness. zxbench probes the server API, starts Desktop
on Windows when needed, waits up to `ZXB_DOCKER_START_TIMEOUT_MS` (default 120,000 ms),
and reports failure without scoring an ungenerated answer. This is independent of
the candidate generation hard time limit (for example 1,200 seconds).

## Runtime protection

- Every availability check probes again; only concurrent in-flight checks are shared.
- Failed Desktop launches have a 30-second cooldown. A manually recovered daemon is
  detected immediately even during cooldown.
- Program/sandbox generation is blocked if Docker cannot become ready. The run pauses
  with a persisted reason, and resume retries the same uncompleted queue item.
- If Docker fails after generation, the answer is saved with an environment flag and
  the run pauses. Resume does not regenerate that completed answer; replay it separately.
- A failed `docker run` is followed by an independent daemon probe. Candidate compiler
  messages alone cannot spoof the daemon-loss check. No automatic user-code retry occurs.
- No socket deletion, factory reset, global WSL shutdown, or container/volume deletion
  outside the invocation's own disposable test container is performed. A Desktop
  initialization failure may still need host-level intervention.
- Every test container has a unique `zxbench-UUID` name and is explicitly removed
  in `finally`, including after CLI timeout. Killing a Docker CLI alone leaves the
  daemon-side container running and is not sufficient cleanup.

## Network-authorized dependency tests

`ZXB_CONTAINER_HTTP_PROXY` explicitly selects a credential-free HTTP(S) proxy for
containers with `networkDisabled: false`. For a Windows loopback proxy it can be
`http://host.docker.internal:PORT`. Do not use `127.0.0.1` inside the container to
reach a host proxy. No host proxy credentials are inherited. Offline containers
remain on `--network none` and receive no proxy through this setting. This does
not change Docker Desktop's global settings or the test's original network policy.

## Saved-answer replay CLI

Build the workspace first. From the workspace root:

```sh
node apps/server/src/scripts/replay-environment-results.mjs --run RUN_ID
node apps/server/src/scripts/replay-environment-results.mjs --run RUN_ID --apply
node apps/server/src/scripts/replay-environment-results.mjs --run RUN_ID --scenario SCENARIO_ID --apply
```

The first command validates the plan without executing tests or changing scores.
Only explicitly selected idle runs and environment-flagged programming results are in
scope. Stop or pause active evaluation workers and allow in-flight answers to drain
before applying recovery. The CLI rechecks persisted run status before execution and
inside each write transaction, but cannot inspect another process's live worker state.

Candidate generation is bypassed completely through `savedCandidate`. The original
answer, reasoning, timing, token metadata, candidate count and generation scenario
version are preserved. If enabled, the run's configured Judge evaluates the newly
available evidence; these are Judge calls, not new candidate generations. Failed Judge
requests remain explicitly marked for review, never represented as successful judging.

Frozen benchmark packs are verified and preferred. Legacy runs without snapshots use
the current definition with matching scenario version; this cannot establish historical
content identity. The optional `--allow-rust-preflight-fix` permits only the known
CP-L4-RS-001 1.2.0-to-1.2.1 preflight revision; execution version/hash is recorded separately.
Multi-attempt aggregated answers and missing sandbox transcripts are rejected.

Verified Rust/C# compiler failures stop the remaining cold test invocations for
that workspace. A subsequent dependency timeout must not erase already-established
compilation failure and turn a model error into an isolated environment result.

The CLI creates a full SQLite backup plus per-result before/replay records under `logs/`.
Optimistic full-row checks prevent overwriting concurrent changes. Successful results
update dimension/total summaries; generated report text is retained and marked stale
in summary rather than silently rewritten. Persistent environment failures retain their
isolated status and score, refresh the failure evidence and replay history, and write
the full new attempt to the recovery artifact.

Do not commit local database backups, candidate answers, logs, or recovery artifacts.
