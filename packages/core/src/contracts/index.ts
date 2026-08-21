// ============================================================
// 场景契约（Phase 1）统一出口
// ============================================================
export { GRADER_CONTRACTS, getGraderContract, listGraderContracts } from './registry.js';
export type { GraderContract } from './registry.js';
export { validateScenario } from './validateScenario.js';
export type { ValidateScenarioOptions } from './validateScenario.js';
export { canonicalizeScenario, hashScenario, hashScenarioShort } from './canonicalize.js';
export { checkScenarioEligibility, partitionByEligibility } from './eligibility.js';
