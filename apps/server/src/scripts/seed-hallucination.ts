/** The exported bank is the single source of truth; never reintroduce inline stale golds. */
import { PrismaClient } from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashScenarioShort } from '@zxbench/core';
if (existsSync(join(process.cwd(), '.env'))) process.loadEnvFile(join(process.cwd(), '.env'));
const prisma = new PrismaClient();
const bank = JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json', import.meta.url), 'utf8'));
async function main() {
  const rows = bank.filter((s: any) => s.dimension === 'hallucination_resistance');
  if (rows.length !== 78 || rows.some((s: any) => s.graderVersion !== 'hallucination_v5' || s.scenarioHash !== hashScenarioShort(s))) throw new Error('Invalid reviewed hallucination contracts');
  await prisma.$transaction(async tx => {
    await tx.scenarioDefinition.updateMany({ where: { dimension: 'hallucination_resistance', id: { startsWith: 'HAL-' } }, data: { status: 'retired' } });
    for (const s of rows) {
      const data = { dimension:s.dimension, category:s.category, difficulty:s.difficulty, language:s.language, locale:s.locale, status:s.status, tier:s.tier, promptTemplate:s.promptTemplate, grader:s.grader, graderVersion:s.graderVersion, requirements:JSON.stringify(s.requirements), scoring:JSON.stringify(s.scoring), scenarioVersion:s.scenarioVersion, scenarioHash:s.scenarioHash, reviewStatus:s.reviewStatus, goldSource:s.goldSource, goldVerifiedAt:new Date(s.goldVerifiedAt) };
      await tx.scenarioDefinition.upsert({ where:{id:s.id}, create:{id:s.id,...data}, update:data });
    }
  }, {timeout:30000});
  console.log('Synced 78 reviewed hallucination contracts; historical results preserved.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>prisma.$disconnect());
