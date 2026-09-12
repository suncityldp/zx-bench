import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectCapabilitySubmission, type InspectionKind, type ClaimReviewAttachment} from '../evaluationLab/capabilityInspection.js';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2), flags = new Map<string, string>();
const usage = 'Usage: --kind methods-v2|proof|probability --pack FROZEN_JSON --submission SUBMISSION_JSON [--reviews REVIEW_PATHS_JSON] --out NEW_JSON';
if (!args.length || args[0] === '--help' || args[0] === '-h') { console.log(usage); process.exit(0); }
for (let i = 0; i < args.length; i += 2) {
  if (!['--kind', '--pack', '--submission', '--reviews', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(args[i])) throw new Error(usage);
  flags.set(args[i], args[i + 1]);
}
for (const key of ['--kind', '--pack', '--submission', '--out']) if (!flags.has(key)) throw new Error(`Missing ${key}`);
const kind = flags.get('--kind')!;
if (!['methods-v2', 'proof', 'probability'].includes(kind)) throw new Error('Unsupported inspection kind');
const destination = resolve(root, flags.get('--out')!);
if (existsSync(destination)) throw new Error('Never overwrite existing inspection or historical result');
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const paths = flags.has('--reviews') ? read(flags.get('--reviews')!) : [];
if (!Array.isArray(paths)) throw new Error('Review paths must be an explicit array');
const reviews: ClaimReviewAttachment[] = paths.map(p => {
  if (!p || typeof p !== 'object' || !['endpoint-v1', 'boundary-v2'].includes(p.kind) ||
      !['questionId', 'questionHash', 'packetPath', 'rawPath', 'reviewPath'].every(k => typeof p[k] === 'string')) throw new Error('Invalid review paths');
  return {kind: p.kind, questionId: p.questionId, questionHash: p.questionHash, packet: read(p.packetPath), raw: read(p.rawPath), review: read(p.reviewPath)};
});
const result = inspectCapabilitySubmission(kind as InspectionKind, read(flags.get('--pack')!), read(flags.get('--submission')!), reviews);
writeFileSync(destination, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({out: destination, planned: result.rows.length, complete: result.complete,
  completionScope: result.completionScope, frozenDimensions: result.frozenDimensions, diagnosticCounts: result.diagnosticCounts,
  evidence: result.evidence && {correct: result.evidence.correct, measured: result.evidence.measured, counts: result.evidence.counts},
  reviewedIssues: result.reviewedIssues, overallProofVerdict: 'unmeasured', networkCalls: 0, historicalScoresChanged: false}));
