import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PR_SQL_DEVELOPMENT_TASK } from './prWitnessSql.js';

it('freezes the production executable-evidence task without claiming human gold', () => {
  const artifact = JSON.parse(readFileSync('data/scenarios/pr-witness-development.json', 'utf8'));
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  expect(artifact).toMatchObject({ status: 'production', registeredGrader: true, independentHumanGold: false,
    oldFreeReviewUnchanged: false, historicalRescoring: false });
  expect(artifact.task).toEqual(PR_SQL_DEVELOPMENT_TASK);
  expect(artifact.taskHash).toBe(hash(JSON.stringify(PR_SQL_DEVELOPMENT_TASK)));
  expect(Object.keys(artifact.sourceHashes)).toContain('packages/core/src/evaluationLab/prWitnessSql.ts');
  const runtime = JSON.parse(readFileSync('data/scenarios/runtime-source-snapshot.json', 'utf8'));
  expect(runtime.historicalSnapshots['data/scenarios/pr-witness-development.json'].sha256)
    .toBe(hash(readFileSync('data/scenarios/pr-witness-development.json', 'utf8').replaceAll('\r\n', '\n')));
  for (const path of Object.keys(artifact.sourceHashes)) {
    expect(hash(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')), path).toBe(runtime.sourceHashes[path]);
  }
});
