import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyEvidenceLedgerV18, type EvidenceLedgerV18Case} from '../evaluationLab/evidenceLedgerV18.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [packArg, runArg, modelKey, outputArg] = process.argv.slice(2);
if (!packArg || !runArg || !modelKey || !outputArg) throw new Error('Usage: PACK RUN MODEL_KEY NEW_OUTPUT');
const packPath = resolve(root, packArg);
const runPath = resolve(root, runArg);
const modelPath = join(runPath, modelKey);
const outputPath = resolve(root, outputArg);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function parseProjection(output: string) {
  const candidates = [output.trim()];
  for (const match of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  const parsed: any[] = [];
  for (const candidate of candidates) {
    try { parsed.push(JSON.parse(candidate)); } catch { /* deterministic no-repair extraction */ }
  }
  const eligible = parsed.filter((value) => value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.claims));
  if (eligible.length !== 1) return {state: eligible.length ? 'ambiguous_json_objects' : 'no_json_object', projection: null, droppedTopLevelKeys: []};
  const value = eligible[0];
  return {state: 'projected', projection: JSON.stringify({claims: value.claims}),
    droppedTopLevelKeys: Object.keys(value).filter((key) => key !== 'claims').sort()};
}

const frozen = read(join(packPath, 'coordinator/frozen-pack.json'));
const cases = frozen.evidence.cases as EvidenceLedgerV18Case[];
const rows = cases.map((testCase) => {
  const resultPath = join(modelPath, testCase.id, 'result.json');
  const result = read(resultPath);
  const output = String(result.output ?? '');
  const extraction = parseProjection(output);
  if (!extraction.projection) return {id: testCase.id, family: testCase.family, variant: testCase.variant,
    outputHash: sha(output), projectionState: extraction.state, semanticProjectionValid: false,
    passedAtoms: null, plannedAtoms: 12, score: null, droppedTopLevelKeys: extraction.droppedTopLevelKeys};
  const verification = verifyEvidenceLedgerV18(testCase, extraction.projection);
  return {id: testCase.id, family: testCase.family, variant: testCase.variant,
    outputHash: sha(output), projectionState: extraction.state, semanticProjectionValid: verification.formatValid,
    passedAtoms: verification.formatValid ? verification.passedAtoms : null, plannedAtoms: 12,
    score: verification.formatValid ? 100 * verification.passedAtoms! / verification.plannedAtoms! : null,
    droppedTopLevelKeys: extraction.droppedTopLevelKeys, verification};
});
const families = [...new Set(rows.map((row) => row.family))].map((family) => {
  const selected = rows.filter((row) => row.family === family);
  const passedAtoms = selected.reduce((sum, row) => sum + (row.passedAtoms ?? 0), 0);
  return {family, plannedQuestions: selected.length, measuredQuestions: selected.filter((row) => row.score !== null).length,
    passedAtoms, plannedAtoms: selected.length * 12,
    score: selected.every((row) => row.score !== null) ? 100 * passedAtoms / (selected.length * 12) : null};
});
const dimensionScore = families.every((family) => family.score !== null)
  ? families.reduce((sum, family) => sum + family.score!, 0) / families.length : null;
const artifact = {
  version: 'hallucination-v18-semantic-projection-audit-2026-09-12-v1',
  sourcePack: packPath, sourceRun: runPath, modelKey,
  role: 'diagnostic_only_not_strict_primary_score',
  projectionRule: 'parse exactly one whole or fenced JSON object; retain claims verbatim; drop top-level non-claims keys only; no claim repair',
  strictFormatScore: null,
  rows, families,
  semanticProjectionScore: dimensionScore,
  formatCompliance: {compliant: 0, planned: rows.length, score: 0},
  judgeCalls: 0, productionWrites: false,
};
writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({output: outputPath, semanticProjectionScore: dimensionScore,
  passedAtoms: rows.reduce((sum, row) => sum + (row.passedAtoms ?? 0), 0), plannedAtoms: rows.length * 12,
  formatCompliance: 0, judgeCalls: 0}));
