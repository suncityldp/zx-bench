import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotHash} from '../contracts/pack.js';
import {buildEvidenceLedgerV18, evidenceLedgerV18Reference, scoreEvidenceLedgerV18} from '../evaluationLab/evidenceLedgerV18.js';
import {buildLatentCensoringProbability, latentCensoringReference, scoreLatentCensoring} from '../evaluationLab/latentCensoringProbability.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [mode, target, ...args] = process.argv.slice(2);
if (!target) throw new Error('Need target');
const dir = resolve(root, target);
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const save = (path: string, value: unknown) => writeFileSync(resolve(root, path), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const sourceFiles = [
  'packages/core/src/evaluationLab/evidenceLedgerV18.ts',
  'packages/core/src/evaluationLab/evidenceLedgerV17.ts',
  'packages/core/src/evaluationLab/evidenceLedgerV16.ts',
  'packages/core/src/evaluationLab/evidenceLedgerV15.ts',
  'packages/core/src/evaluationLab/evidenceLedgerV14.ts',
  'packages/core/src/evaluationLab/evidenceLedgerV13.ts',
  'packages/core/src/evaluationLab/latentCensoringProbability.ts',
  'packages/core/src/evaluationLab/certificateDiagnostic.ts',
  'packages/core/src/evaluationLab/challengeTypes.ts',
  'packages/core/src/evaluationLab/methodsV2/types.ts',
  'packages/core/src/evaluationLab/methodsV2/verify.ts',
  'packages/core/src/contracts/pack.ts',
  'packages/core/src/scripts/hard-dimensions-v18.ts',
];
const sourceHashes = () => Object.fromEntries(sourceFiles.map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));

function build(seed: number) {
  const evidence = buildEvidenceLedgerV18(seed);
  const math = buildLatentCensoringProbability(seed);
  const policy = {
    version: 'resistance-math-hard-dimensions-2026-09-12-v1.8', seed, questions: 12,
    hallucinationQuestions: 6, mathQuestions: 6, judgeCalls: 0, combinedScore: null,
    productionEligible: false,
    selection: 'development_after_v1.7_all_allowed_sources_changed_to_broad_topic_bounded_sets',
  };
  const questions = [...evidence.questions, ...math.questions];
  return {policy, evidence, math, questions, contractHash: snapshotHash({policy, evidence: evidence.contractHash, math: math.contractHash, questions})};
}

if (mode === 'export' && args.length === 1) {
  if (existsSync(dir)) throw new Error('Never overwrite pack');
  const seed = Number(args[0]);
  const pack = build(seed);
  const evidenceAnswers = pack.evidence.cases.map((testCase) => ({id: testCase.id, questionHash: testCase.question.questionHash, outcome: 'completed', output: JSON.stringify(evidenceLedgerV18Reference(testCase))}));
  const mathAnswers = pack.math.cases.map((testCase) => ({id: testCase.id, questionHash: testCase.question.questionHash, outcome: 'completed', output: JSON.stringify(latentCensoringReference(testCase.problem).answer)}));
  const evidenceQa = scoreEvidenceLedgerV18(pack.evidence, {contractHash: pack.evidence.contractHash, runId: 'oracle', modelId: 'oracle', modelFamily: 'synthetic', answers: evidenceAnswers});
  const mathQa = scoreLatentCensoring(pack.math, {contractHash: pack.math.contractHash, runId: 'oracle', modelId: 'oracle', modelFamily: 'synthetic', answers: mathAnswers});
  if (evidenceQa.rows.some((row) => row.pass !== true) || mathQa.rows.some((row) => row.pass !== true)) throw new Error('Reference QA failed');
  const publicPack = {version: pack.policy.version, contractHash: pack.contractHash, questions: pack.questions};
  const hashes = sourceHashes();
  mkdirSync(join(dir, 'coordinator'), {recursive: true});
  save(join(dir, 'candidate-questions.json'), publicPack);
  save(join(dir, 'coordinator/frozen-pack.json'), pack);
  save(join(dir, 'coordinator/reference-QA-not-model.json'), {evidenceAnswers, mathAnswers, evidenceQa, mathQa});
  save(join(dir, 'manifest.json'), {
    version: pack.policy.version, seed, contractHash: pack.contractHash, publicHash: snapshotHash(publicPack),
    sourceFiles: hashes, sourceHash: snapshotHash(hashes), modelCalls: 0, judgeCalls: 0, productionWrites: false,
    supersedesForFutureDevelopmentOnly: 'resistance-math-hard-candidates-2026-09-12-v1.7',
    reason: 'Required sources remain decisive; allowed sources are broad topic clusters so only clearly cross-topic evidence is penalized.',
  });
  console.log(JSON.stringify({directory: target, questions: 12, evidenceAtoms: 72, mathExactValues: 36, modelCalls: 0, judgeCalls: 0}));
} else if ((mode === 'verify' && args.length === 0) || (mode === 'grade' && args.length === 2)) {
  const manifest = read(join(dir, 'manifest.json'));
  const frozen = read(join(dir, 'coordinator/frozen-pack.json'));
  const fresh = build(manifest.seed);
  const publicPack = read(join(dir, 'candidate-questions.json'));
  const hashes = sourceHashes();
  if (
    snapshotHash(frozen) !== snapshotHash(fresh) || snapshotHash(hashes) !== manifest.sourceHash ||
    snapshotHash(hashes) !== snapshotHash(manifest.sourceFiles) || frozen.contractHash !== manifest.contractHash ||
    snapshotHash(publicPack) !== manifest.publicHash ||
    snapshotHash(publicPack) !== snapshotHash({version: frozen.policy.version, contractHash: frozen.contractHash, questions: frozen.questions})
  ) throw new Error('Frozen data or code changed');
  if (mode === 'verify') {
    console.log(JSON.stringify({verified: true, questions: 12, contractHash: frozen.contractHash}));
  } else {
    const input = read(args[0]);
    if (input.contractHash !== frozen.contractHash || !Array.isArray(input.answers) || !['runId', 'modelId', 'modelFamily'].every((key) => typeof input[key] === 'string' && input[key].trim())) throw new Error('Invalid combined submission');
    const evidenceIds = new Set(frozen.evidence.cases.map((testCase: any) => testCase.id));
    const evidence = scoreEvidenceLedgerV18(fresh.evidence, {contractHash: fresh.evidence.contractHash, runId: input.runId, modelId: input.modelId, modelFamily: input.modelFamily, answers: input.answers.filter((answer: any) => evidenceIds.has(answer.id))});
    const math = scoreLatentCensoring(fresh.math, {contractHash: fresh.math.contractHash, runId: input.runId, modelId: input.modelId, modelFamily: input.modelFamily, answers: input.answers.filter((answer: any) => !evidenceIds.has(answer.id))});
    const result = {
      version: fresh.policy.version, contractHash: fresh.contractHash, runId: input.runId,
      modelId: input.modelId, modelFamily: input.modelFamily, evidence, math,
      dimensions: [evidence.dimensions[0], math.dimensions[0]], combinedScore: null,
      judgeCalls: 0, difficultyCalibrated: false, productionEligible: false, codeHash: manifest.sourceHash,
    };
    save(args[1], result);
    console.log(JSON.stringify({result: resolve(root, args[1]), dimensions: result.dimensions, judgeCalls: 0}));
  }
} else {
  throw new Error('Usage: export NEW_DIR SEED | verify DIR | grade DIR SUBMISSION NEW_RESULT');
}
