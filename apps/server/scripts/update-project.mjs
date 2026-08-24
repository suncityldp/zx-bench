// update-project.mjs <id> <patchJson> — 合并更新 project_repair 场景 requirements
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
if (!row) { console.log(JSON.stringify({ ok: false, error: 'NOT_FOUND' })); process.exit(0); }
const req = row.requirements ? JSON.parse(row.requirements) : {};
if (patch.hiddenTests) req.hiddenTests = patch.hiddenTests;
if (patch.files) {
  const m = new Map((req.files || []).map((f) => [f.path, f]));
  for (const f of patch.files) m.set(f.path, f);
  req.files = [...m.values()];
}
if (patch.hiddenTestFiles) {
  const m = new Map((req.hiddenTestFiles || []).map((f) => [f.path, f]));
  for (const f of patch.hiddenTestFiles) m.set(f.path, f);
  req.hiddenTestFiles = [...m.values()];
}
if (patch.image) req.image = patch.image;
await prisma.scenarioDefinition.update({ where: { id }, data: { requirements: JSON.stringify(req) } });
console.log(JSON.stringify({ ok: true, id, hiddenTests: (req.hiddenTests || []).length, files: (req.files || []).length }));
await prisma.$disconnect();
