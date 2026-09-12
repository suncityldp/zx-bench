import { PrismaClient } from '@prisma/client';
import type { CalibrationCandidate } from '@zxbench/types';
import { fileURLToPath } from 'node:url';
import { collectRunCandidates, intakeRuns } from '../calibration/intake.js';
import { getCalibrationStore } from '../calibration/store.js';
import { sampleCalibrationCandidates } from '@zxbench/core';

const args = process.argv.slice(2);
const runIds: string[] = [];
let count = 60;
let apply = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run') runIds.push(args[++i]);
  else if (args[i] === '--count') count = Number(args[++i]);
  else if (args[i] === '--apply') apply = true;
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!runIds.length || runIds.some(id => !id) || runIds.length > 20) throw new Error('Usage: calibration:intake --run RUN_ID [--run RUN_ID] [--count 60] [--apply]. Default is read-only dry run.');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL || `file:${fileURLToPath(new URL('../../../data/zxbench.db', import.meta.url))}` } } });
try {
  if (apply) {
    const store = getCalibrationStore();
    try { console.log(JSON.stringify(await intakeRuns(prisma, store, runIds, count, true), null, 2)); }
    finally { store.close(); }
  } else {
    const candidates: CalibrationCandidate[] = [];
    for (const id of [...new Set(runIds)]) candidates.push(...await collectRunCandidates(prisma, id, true));
    const selected = sampleCalibrationCandidates(candidates, count, 'zxbench-p1-2026-09-08');
    const tally = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length]));
    console.log(JSON.stringify({ dryRun: true, inspected: candidates.length, selected: selected.length,
      dimensions: tally(selected.map(c => c.scenario.dimension)), splits: tally(selected.map(c => c.split)),
      failureTypes: tally(selected.flatMap(c => c.failureTypes.length ? c.failureTypes : ['control'])),
      reconstructed: selected.filter(c => c.snapshotOrigin === 'current_definition').length,
      scenarioIds: selected.map(c => c.scenario.id) }, null, 2));
  }
} catch (err) { console.error(String(err)); process.exitCode = 1; }
finally { await prisma.$disconnect(); }
