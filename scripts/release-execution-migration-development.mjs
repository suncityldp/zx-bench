// Publish the frozen execution migration as explicitly selectable development scenarios.
// Usage: node scripts/release-execution-migration-development.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hashScenarioShort } from '../packages/core/dist/contracts/canonicalize.js';
import { validateScenario } from '../packages/core/dist/contracts/validateScenario.js';

const root = path.resolve(import.meta.dirname, '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'data/execution/migration-plan.json'), 'utf8'));
const packNames = ['cli-original-docker-v1', 'cli-advanced-docker-v1', 'recovery-world-docker-v1',
  'cli-execution-v1', 'tool-world-v1', 'retail-docker-v1', 'shell-investigation-v1', 'special-shell-v1'];
const byId = new Map(packNames.flatMap((name) => JSON.parse(fs.readFileSync(
  path.join(root, 'data/pilots', `${name}.json`), 'utf8'))).map((scenario) => [scenario.id, scenario]));
// Packaged task contracts are authoritative when a reviewed fix has superseded
// its pilot copy. The frozen plan and canonical hash checks below still apply.
for (const task of plan.migrationTasks) {
  const file = path.join(root, 'data/execution/tasks', task.taskId, 'scenario.json');
  if (fs.existsSync(file)) byId.set(task.taskId, JSON.parse(fs.readFileSync(file, 'utf8')));
}
if (plan.sourceCount !== 189 || plan.taskCount !== 306 || plan.migrationTasks.length !== 306
  || new Set(plan.migrationTasks.map((task) => task.sourceId)).size !== 189) {
  throw Error('Frozen migration plan does not contain 189 sources and 306 task instances');
}
const scenarios = plan.migrationTasks.map((task) => {
  const scenario = byId.get(task.taskId);
  if (!scenario || scenario.status !== 'valid' || scenario.requirements?.developmentShadow !== true
    || (scenario.requirements?.migrationSourceId && scenario.requirements.migrationSourceId !== task.sourceId)
    || (task.scenarioHash && scenario.scenarioHash !== task.scenarioHash)) {
    throw Error(`Invalid development task mapping: ${task.taskId}`);
  }
  const report = validateScenario(scenario);
  if (report.errors.length || scenario.scenarioHash !== hashScenarioShort(scenario)) {
    throw Error(`Invalid frozen task contract: ${task.taskId}`);
  }
  return scenario;
});
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:J:/AI/zxbench-runtime/data/zxbench.db';
const prisma = new PrismaClient();
const jsonFields = new Set(['scoring', 'hiddenTests', 'requirements', 'tags', 'toolSchema',
  'expectedState', 'requiredInvariants', 'allowedActions', 'forbiddenActions', 'requiredOrder']);
const nullableFields = ['sourceCode', 'functionName', 'expectedVerdict', 'hiddenTests', 'requirements',
  'tags', 'responseMode', 'outputPolicy', 'toolSchema', 'expectedState', 'requiredInvariants',
  'allowedActions', 'forbiddenActions', 'requiredOrder', 'environmentImage', 'seed', 'goldSource',
  'goldVerifiedAt', 'answerFirst', 'maxAnswerTokens', 'maxReasoningTokens'];
function encode(scenario) {
  const data = {};
  for (const [key, value] of Object.entries(scenario)) {
    if (key === 'id' || key === 'createdAt' || key === 'updatedAt') continue;
    data[key] = key === 'goldVerifiedAt' && value ? new Date(value)
      : jsonFields.has(key) && value != null ? JSON.stringify(value) : value;
  }
  for (const key of nullableFields) data[key] ??= null;
  data.reviewStatus ??= 'unreviewed';
  return data;
}
try {
  const ids = scenarios.map((scenario) => scenario.id);
  const existing = await prisma.scenarioDefinition.findMany({ where: { id: { in: ids } },
    select: { id: true, scenarioHash: true, status: true } });
  const drift = existing.filter((row) => {
    const expected = byId.get(row.id);
    return row.scenarioHash !== expected.scenarioHash || row.status !== 'valid';
  });
  if (drift.length) throw Error(`Existing task definitions differ: ${drift.map((row) => row.id).slice(0, 8)}`);
  const missing = scenarios.filter((scenario) => !existing.some((row) => row.id === scenario.id));
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, sources: 189, tasks: 306,
      alreadyPublished: existing.length, toPublish: missing.length }));
  } else {
    const active = await prisma.evalRun.count({ where: { status: { in: ['running', 'pending', 'queued'] } } });
    if (active) throw Error(`Refusing publication while ${active} database evaluation(s) are active`);
    await prisma.$transaction(async (tx) => {
      if (await tx.evalRun.count({ where: { status: { in: ['running', 'pending', 'queued'] } } })) {
        throw Error('Evaluation started during development task publication');
      }
      for (const scenario of missing) {
        await tx.scenarioDefinition.create({ data: { id: scenario.id, ...encode(scenario) } });
      }
    }, { timeout: 120_000 });
    const published = await prisma.scenarioDefinition.findMany({ where: { id: { in: ids } },
      select: { id: true, scenarioHash: true, status: true, requirements: true } });
    if (published.length !== 306 || published.some((row) => row.status !== 'valid'
      || row.scenarioHash !== byId.get(row.id).scenarioHash
      || JSON.parse(row.requirements || '{}').developmentShadow !== true)) {
      throw Error('Published development task verification failed');
    }
    console.log(JSON.stringify({ published: published.length, sources: 189,
      inserted: missing.length, retained: existing.length }));
  }
} finally {
  await prisma.$disconnect();
}
