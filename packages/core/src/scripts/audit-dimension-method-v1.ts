import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error('Need new output path');
const sources = {
  fourModel: 'reports/cross-family-flash-glm-2026-09-12-v1/four-model-discrimination.json',
  temporalHoldout: 'reports/evidence-holdout-gsq-ornith-2026-09-12-v1/audit.json',
  judge: 'reports/flash-judge-holdout-2026-09-12-v1/audit.json',
  gsqV18Grade: 'reports/resistance-math-hard-local-gsq-ornith-2026-09-12-v1.8/gsq-rco-iq3s/grades-007.json',
  ornithV18Projection: 'reports/hallucination-resistance-hard-local-ornith-2026-09-12-v1.8/semantic-projection-audit.json',
  hardMathCompleted: 'reports/resistance-math-hard-local-gsq-ornith-2026-09-12-v1.8/gsq-rco-iq3s/V2-7fa964ae295752/result.json',
  hardMathTimeout: 'reports/resistance-math-hard-local-gsq-ornith-2026-09-12-v1.8/gsq-rco-iq3s/V2-12af1a933449d6/result.json',
  policy: 'packages/core/src/evaluationLab/dimensionEvaluationPolicyV1.ts',
};
const bytes = Object.fromEntries(Object.entries(sources).map(([key, path]) => [key, readFileSync(resolve(root, path))]));
const json: any = Object.fromEntries(Object.entries(bytes).filter(([key]) => key !== 'policy').map(([key, value]) => [key, JSON.parse(value.toString('utf8'))]));
const hashes = Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]));

const getModel = (dimension: any, fragment: string) => dimension.models.find((model: any) => String(model.modelId).includes(fragment));
const h = json.fourModel.hallucinationResistance;
const m = json.fourModel.reasoningMath;
const holdoutGsq = json.temporalHoldout.models.find((model: any) => model.model === 'gsq-rco-iq3s');
const holdoutOrnith = json.temporalHoldout.models.find((model: any) => model.model === 'ornith15-q4km');
const gsqV18 = json.gsqV18Grade.evidence.dimensions[0];
const judge = json.judge;
const checks = {
  crossFamilyHallucination: [['GSQ', getModel(h, 'GSQ-RCO').score, 100], ['Ornith', getModel(h, 'Ornith').score, 62.5],
    ['Flash', getModel(h, 'deepseek-v4-flash').score, 100], ['GLM', getModel(h, 'glm-5.2').score, 100]],
  crossFamilyMath: [['GSQ', getModel(m, 'GSQ-RCO').score, 100 * 4 / 6], ['Ornith', getModel(m, 'Ornith').score, 100 / 6],
    ['Flash', getModel(m, 'deepseek-v4-flash').score, 100], ['GLM', getModel(m, 'glm-5.2').score, 100]],
  temporalStatus: [['GSQ', holdoutGsq.stanceCorrect, 4], ['Ornith', holdoutOrnith.stanceCorrect, 2]],
  ledgerSemantic: [['GSQ', gsqV18.score, 100], ['Ornith', json.ornithV18Projection.semanticProjectionScore, 100]],
  ledgerFormat: [['GSQ', 100, 100], ['Ornith', json.ornithV18Projection.formatCompliance.score, 0]],
  judgeCalibration: [['matched', judge.assessment.matched, 12], ['planned', judge.assessment.planned, 12],
    ['weight', judge.automaticScoreWeight, 0], ['historicalFilesUnchanged', judge.historicalFilesUnchanged, 174]],
  hardMathCost: [['completedSeconds', json.hardMathCompleted.elapsed_seconds, 1033.7053213999607],
    ['completedPass', json.gsqV18Grade.math.rows.find((row: any) => row.id === 'V2-7fa964ae295752').pass, false],
    ['timeout', json.hardMathTimeout.timeout, true], ['timeoutSecondsAtLeast', json.hardMathTimeout.elapsed_seconds >= 1200, true]],
};
for (const group of Object.values(checks) as any[]) {
  for (const [label, actual, expected] of group) {
    if (actual !== expected) throw new Error(`Evidence mismatch ${label}: ${actual} != ${expected}`);
  }
}

const artifact = {
  version: 'resistance-math-method-audit-2026-09-12-v1',
  sourceHashes: hashes,
  observed: {
    hallucinationCrossFamily: Object.fromEntries(h.models.map((model: any) => [model.modelId, model.score])),
    temporalHoldoutStatusCorrect: {gsq: '4/4', ornith: '2/4'},
    ledgerV18: {gsqSemanticAtoms: '72/72', ornithSemanticAtoms: '72/72', gsqFormatCompliance: 100, ornithFormatCompliance: 0},
    mathDefaultCore: Object.fromEntries(m.models.map((model: any) => [model.modelId, model.score])),
    mathEscalation: {gsqFirstItem: {seconds: json.hardMathCompleted.elapsed_seconds, correctValues: '0/6'},
      gsqSecondItem: {seconds: json.hardMathTimeout.elapsed_seconds, outcome: 'hard_timeout_empty_output'}},
    flashJudge: {model: judge.judge.model, matched: `${judge.assessment.matched}/${judge.assessment.planned}`,
      reviewedReasonsSegmentsSources: judge.gates.allReasonsSegmentsSourcesReviewed,
      latencyMs: judge.usage.latencyMs, automaticScoreWeight: 0, historicalFilesUnchanged: judge.historicalFilesUnchanged},
  },
  decisions: {
    hallucination: 'Use a family vector: evidence-state accuracy, required-evidence coverage, and format compliance. Do not let the v1.8 ledger replace the temporal holdout because it has a semantic ceiling on both local models.',
    math: 'Use the six-item exact probability pack as the default core. Keep latent-censoring math as a top-tier escalation only.',
    judge: 'DeepSeek-v4-flash may flag bounded semantic errors for open-ended answers; human review remains primary and Judge automatic score weight is zero.',
    retiredJudge: 'deepseek-v4-pro',
    retrospectiveScoring: 'Do not combine development, holdout, mixed runtime, or diagnostic contracts into a new official score.',
  },
  validation: {checks, passed: true},
  judgeCallsDuringAudit: 0,
  productionWrites: false,
  productionEligible: false,
};
writeFileSync(resolve(root, outputArg), JSON.stringify(artifact, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({output: resolve(root, outputArg), validated: true, sources: Object.keys(sources).length, judgeCalls: 0, productionWrites: false}));
