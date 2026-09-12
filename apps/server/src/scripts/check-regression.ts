import fs from 'node:fs';
import { checkRegression, parseRegressionExport } from '@zxbench/core';

const [baselinePath, candidatePath, tolerance = '0'] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error('Usage: pnpm --filter server regression:check baseline.json candidate.json [maxScoreDrop]');
  process.exitCode = 2;
} else {
  try {
    const result = checkRegression(parseRegressionExport(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))),
      parseRegressionExport(JSON.parse(fs.readFileSync(candidatePath, 'utf8'))), Number(tolerance));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch (err) { console.error(String(err)); process.exitCode = 2; }
}
