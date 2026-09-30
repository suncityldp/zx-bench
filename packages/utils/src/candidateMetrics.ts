/** Request/loop elapsed time includes network, prefill and (for loops) tools.
 * It is not pure generation time. Never mix untimed tokens into its numerator. */
export interface CandidateMetrics {
  sampleCount: number;
  tokenSampleCount: number;
  timedSampleCount: number;
  generationSampleCount: number;
  tokenCoverage: number;
  timingCoverage: number;
  generationCoverage: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalTokens: number | null;
  timedOutputTokens: number | null;
  candidateElapsedMs: number | null;
  candidateTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
}

interface Metadata {
  candidateGenerated?: boolean;
  evaluationAudit?: { attempts?: { outputMetadata?: unknown }[] };
  inputTokens?: number;
  outputTokens?: number;
  inferenceMs?: number;
  tokenSpeed?: number;
  generationMs?: number;
  nativeTokensPerSecond?: number;
  agentLoopTrace?: unknown;
  executionWorldTrace?: unknown;
  shellExecutionTrace?: unknown;
}
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function metadata(row: { outputMetadata?: unknown }): Metadata {
  try {
    const value = typeof row.outputMetadata === 'string' ? JSON.parse(row.outputMetadata) : row.outputMetadata;
    return value && typeof value === 'object' ? value as Metadata : {};
  } catch { return {}; }
}

export function aggregateCandidateMetrics(rows: { outputMetadata?: unknown }[], options: { consumed?: boolean } = {}): CandidateMetrics {
  if (options.consumed) rows = rows.filter(row => metadata(row).candidateGenerated !== false);
  rows = rows.flatMap(row => {
    const attempts = metadata(row).evaluationAudit?.attempts;
    return Array.isArray(attempts) && attempts.length ? attempts : [row];
  });
  if (options.consumed) rows = rows.filter(row => metadata(row).candidateGenerated !== false);
  let inputs = 0, outputs = 0, timedOutputs = 0, elapsed = 0, tokens = 0, timed = 0;
  const speeds: number[] = [];
  for (const row of rows) {
    const m = metadata(row);
    if (nonnegative(m.inputTokens) && nonnegative(m.outputTokens)) { tokens++; inputs += m.inputTokens; outputs += m.outputTokens; }
    if (nonnegative(m.outputTokens) && nonnegative(m.inferenceMs) && m.inferenceMs > 0) { timed++; timedOutputs += m.outputTokens; elapsed += m.inferenceMs; }
    // Only provider or stream generation timing qualifies. An older computed
    // outputTokens/inferenceMs fallback is not a generation measurement.
    const speed = m.nativeTokensPerSecond ?? (nonnegative(m.generationMs) && m.generationMs > 0 && nonnegative(m.outputTokens) ? m.outputTokens * 1000 / m.generationMs : undefined);
    if (!m.agentLoopTrace && !m.executionWorldTrace && !m.shellExecutionTrace && nonnegative(speed)) speeds.push(speed);
  }
  speeds.sort((a, b) => a - b);
  const n = rows.length;
  const mid = Math.floor(speeds.length / 2);
  return {
    sampleCount: n, tokenSampleCount: tokens, timedSampleCount: timed, generationSampleCount: speeds.length,
    tokenCoverage: n ? tokens / n : 0, timingCoverage: n ? timed / n : 0, generationCoverage: n ? speeds.length / n : 0,
    totalInputTokens: tokens ? inputs : null, totalOutputTokens: tokens ? outputs : null, totalTokens: tokens ? inputs + outputs : null,
    timedOutputTokens: timed ? timedOutputs : null, candidateElapsedMs: timed ? elapsed : null,
    candidateTokensPerSecond: timed ? timedOutputs * 1000 / elapsed : null,
    generationTokensPerSecond: speeds.length ? (speeds.length % 2 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2) : null,
  };
}

/** Combine groups using additive paired samples; no maximum-speed shortcut. */
export function combineCandidateMetrics(groups: CandidateMetrics[]): CandidateMetrics {
  const sum = (key: keyof CandidateMetrics) => groups.reduce((s, g) => s + (typeof g[key] === 'number' ? g[key]! : 0), 0);
  const n = sum('sampleCount'), tokens = sum('tokenSampleCount'), timed = sum('timedSampleCount');
  const elapsed = sum('candidateElapsedMs'), output = sum('timedOutputTokens');
  return {
    sampleCount: n, tokenSampleCount: tokens, timedSampleCount: timed, generationSampleCount: 0,
    tokenCoverage: n ? tokens / n : 0, timingCoverage: n ? timed / n : 0, generationCoverage: 0,
    totalInputTokens: tokens ? sum('totalInputTokens') : null, totalOutputTokens: tokens ? sum('totalOutputTokens') : null, totalTokens: tokens ? sum('totalTokens') : null,
    timedOutputTokens: timed ? output : null, candidateElapsedMs: timed ? elapsed : null,
    candidateTokensPerSecond: timed && elapsed > 0 ? output * 1000 / elapsed : null,
    // A median cannot be recovered by combining medians.
    generationTokensPerSecond: null,
  };
}
