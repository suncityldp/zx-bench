# Inference relay and runtime monitoring

The shared helpers in `scripts/lib/` preserve the fixes used by the local
benchmark runtime. They do not change model sampling, reasoning/output budgets,
KV precision, benchmark scores, or existing question records.

- `guarded-inference-proxy.mjs` relays one active inference request, handles
  upstream connection resets, HTTP errors, idle timeouts and incomplete SSE,
  closes admission immediately after a failure, and captures asynchronous
  failure-handler errors. Caller cancellation releases the slot without
  misclassifying it as a backend fault. Health checks remain independent of
  asynchronous request preparation. Reopening requires explicit verified
  recovery through `resetAfterVerifiedRecovery()`.
- `runtime-fault-policy.mjs` detects dead relay/guard processes, stale guard
  heartbeats, unexpected benchmark pauses and report-export failures. Incidents
  are compared with the persisted resume epoch, so restarting a watcher cannot
  hide a still-current fault. A bounded resume grace period avoids treating an
  old controller's terminal snapshot as a new failure. Normal progress and
  completed reports remain silent.
- `process-fault-supervisor.mjs` observes child exit/spawn errors immediately
  and invokes the caller's failure handler once. Planned maintenance is silent.
- `exception-once.mjs` uses SQLite claims to deduplicate notifications across
  processes. Failed or abandoned claims can be retried. Callers should include
  the persisted run/resume epoch in each incident key and only resolve their
  `send` callback after successful delivery.
- `atomic-runtime-json.mjs` writes complete snapshots through unique temporary
  files, with bounded retries for transient Windows replacement errors.
- `gpu-reserve-observation.mjs` records low desktop VRAM as diagnostic data.
  An arbitrary reserve threshold does not independently authorize pausing a run.
  Actual OOM, backend capacity and budget checks remain the caller's responsibility.

Runtime-specific adapters supply authorization, exact model/budget/capacity
checks, upstream headers, audit persistence, verified recovery, benchmark pause
and notification delivery. These helpers do not automatically install a relay,
start a watcher or provide an operating-system notification transport. Avoid
blocking process-discovery commands in the relay event loop; use asynchronous
queries with a bounded timeout in adapters.

Run the isolated regression suite with Node.js 22.13 or later:

```sh
pnpm test:inference-reliability
```

The same suite runs before `pnpm test`. Tests use ephemeral loopback servers,
test-only child processes and temporary state; they do not call a model,
pause a real benchmark or display notifications. They cover transport failure
containment, cancellation, slot ownership, recovery, watcher freshness,
notification deduplication, concurrent snapshot writes and diagnostic-only VRAM.
