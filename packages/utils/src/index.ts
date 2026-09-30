// ============================================================
// @zxbench/utils — 工具函数
// ============================================================

export { generateId, generateRunId } from './id.js';
export { aggregateCandidateMetrics, combineCandidateMetrics } from './candidateMetrics.js';
export type { CandidateMetrics } from './candidateMetrics.js';
export { sha256, scenarioHash } from './hash.js';
export {
  mean,
  median,
  stdDev,
  confidenceInterval95,
  bootstrapCI,
  multiRunStats,
} from './stats.js';
export { detectTruncation, buildOutputMetadata } from './truncation.js';
export { generateParameterVariable, instantiateScenario } from './parameterize.js';
