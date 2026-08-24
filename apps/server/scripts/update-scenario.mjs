// update-scenario.mjs <id> <patchJsonPath> — 更新场景 hiddenTests/sourceCode/promptTemplate
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const prisma = new PrismaClient();
const id = process.argv[2];
const patch = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const row = await prisma.scenarioDefinition.findUnique({ where: { id } });
if (!row) { console.log(JSON.stringify({ ok: false, error: 'NOT_FOUND', id })); process.exit(0); }
const data = {};
if (patch.hiddenTests) {
  data.hiddenTests = JSON.stringify(patch.hiddenTests);
  const req = row.requirements ? JSON.parse(row.requirements) : {};
  req.hiddenTests = patch.hiddenTests.map((h) => ({ code: h.testCode, description: h.description }));
  data.requirements = JSON.stringify(req);
}
if (patch.sourceCode !== undefined) data.sourceCode = patch.sourceCode;
if (patch.promptTemplate !== undefined) data.promptTemplate = patch.promptTemplate;
if (patch.requirements !== undefined) data.requirements = JSON.stringify(patch.requirements);
await prisma.scenarioDefinition.update({ where: { id }, data });
console.log(JSON.stringify({ ok: true, id, tests: patch.hiddenTests ? patch.hiddenTests.length : 'unchanged' }));
await prisma.$disconnect();
