/**
 * 编程题难度实证重标脚本（数据驱动校准）
 *
 * 背景：program 维度 150 题的难度标注与实证表现脱节（medium 均分 70.4 vs hard 70.9 无差；
 * hard 内部标准差 13.3）。本脚本按题目实证均分重划难度档位，让 DIFFICULTY_WEIGHTS
 * 加权体系建立在真实难度之上。
 *
 * 分档规则（锚定全量实证分位数 p75=79.2 / p50=70.6 / p25=56.4，取整为清洁截断值）：
 *   avg >= 80        → easy        (权重 1.0)
 *   70 <= avg < 80   → medium      (权重 1.5)
 *   55 <= avg < 70   → hard        (权重 2.0)
 *   avg < 55         → adversarial (权重 2.5)
 *
 * 例外：long_task_* 类目（20 题）为攻击性质标签，强制保持 adversarial；
 *      其在维度加权中的权重由聚合层的 LONG_TASK_WEIGHT=3.0 单独覆盖，与本标签无关。
 *
 * 校准口径：全部历史结果（排除 environmentError 行）的题目均分；所有题 n>=5。
 * 注意：难度标签来自同一批被评测的数据（校准性重标），题集或模型池变更后应重新校准。
 *
 * 用法：
 *   npx tsx src/scripts/relabel-program-difficulty.ts           # dry-run（默认，只打印）
 *   npx tsx src/scripts/relabel-program-difficulty.ts --apply   # 实际写入 DB
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const EASY_CUTOFF = 80;
const MEDIUM_CUTOFF = 70;
const HARD_CUTOFF = 55;

function bandFor(avg: number): string {
  if (avg >= EASY_CUTOFF) return 'easy';
  if (avg >= MEDIUM_CUTOFF) return 'medium';
  if (avg >= HARD_CUTOFF) return 'hard';
  return 'adversarial';
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`\n===== 编程题难度实证重标 ${apply ? '[APPLY 模式：将写入 DB]' : '[DRY-RUN 模式：仅打印]'} =====\n`);

  // 1. 全部 program 有效题
  const scenarios = await prisma.scenarioDefinition.findMany({
    where: { dimension: 'program', status: 'valid' },
    select: { id: true, category: true, difficulty: true },
  });
  const ids = scenarios.map((s) => s.id);

  // 2. 实证均分（排除环境故障行；含重试行的全部行）
  const results = await prisma.scenarioResult.findMany({
    where: { scenarioId: { in: ids } },
    select: { scenarioId: true, totalScore: true, environmentError: true },
  });
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of results) {
    if (r.environmentError === true) continue;
    const cur = sums.get(r.scenarioId) || { sum: 0, n: 0 };
    cur.sum += r.totalScore;
    cur.n += 1;
    sums.set(r.scenarioId, cur);
  }

  // 3. 计算新档位
  const changes: Array<{ id: string; category: string; oldDiff: string; newDiff: string; avg: number; n: number }> = [];
  const unchanged: string[] = [];
  const newDist: Record<string, number> = { easy: 0, medium: 0, hard: 0, adversarial: 0 };
  const oldDist: Record<string, number> = { easy: 0, medium: 0, hard: 0, adversarial: 0 };

  for (const s of scenarios) {
    oldDist[s.difficulty] = (oldDist[s.difficulty] || 0) + 1;
    const stat = sums.get(s.id);
    if (!stat || stat.n === 0) {
      console.warn(`  [警告] ${s.id} 无有效实证数据，保持原标签 ${s.difficulty}`);
      newDist[s.difficulty] = (newDist[s.difficulty] || 0) + 1;
      continue;
    }
    const avg = stat.sum / stat.n;
    const isLongTask = s.category.startsWith('long_task');
    const newDiff = isLongTask ? 'adversarial' : bandFor(avg);
    newDist[newDiff] = (newDist[newDiff] || 0) + 1;
    if (newDiff !== s.difficulty) {
      changes.push({ id: s.id, category: s.category, oldDiff: s.difficulty, newDiff, avg: Math.round(avg * 10) / 10, n: stat.n });
    } else {
      unchanged.push(s.id);
    }
  }

  // 4. 输出
  console.log(`题数: ${scenarios.length}（变更 ${changes.length}，保持 ${unchanged.length}）\n`);
  console.log('难度分布 旧 → 新:');
  for (const k of ['easy', 'medium', 'hard', 'adversarial']) {
    console.log(`  ${k.padEnd(12)} ${String(oldDist[k] || 0).padStart(3)} → ${String(newDist[k] || 0).padStart(3)}`);
  }
  console.log('\n变更明细（升档↑ / 降档↓）:');
  const rank: Record<string, number> = { easy: 0, medium: 1, hard: 2, adversarial: 3 };
  changes.sort((a, b) => (rank[b.newDiff] - rank[b.oldDiff]) - (rank[a.newDiff] - rank[a.oldDiff]) || a.avg - b.avg);
  for (const c of changes) {
    const arrow = rank[c.newDiff] > rank[c.oldDiff] ? '↑' : rank[c.newDiff] < rank[c.oldDiff] ? '↓' : '=';
    console.log(`  ${arrow} ${c.id} [${c.category.slice(0, 28)}] ${c.oldDiff} → ${c.newDiff}  (均分 ${c.avg}, n=${c.n})`);
  }

  // 5. 写入
  if (apply) {
    console.log(`\n写入 ${changes.length} 题的新难度标签...`);
    for (const c of changes) {
      await prisma.scenarioDefinition.update({
        where: { id: c.id },
        data: { difficulty: c.newDiff },
      });
    }
    // 审计记录：映射 + 校准参数，供追溯
    const audit = {
      calibratedAt: new Date().toISOString(),
      dimension: 'program',
      cutoffs: { easy: EASY_CUTOFF, medium: MEDIUM_CUTOFF, hard: HARD_CUTOFF },
      note: '按实证均分分位校准；long_task_* 强制 adversarial；聚合权重由 LONG_TASK_WEIGHT=3.0 覆盖',
      total: scenarios.length,
      changed: changes.length,
      changes,
    };
    const fs = await import('node:fs');
    const auditPath = new URL('../../../data/relabel-program-audit.json', import.meta.url);
    fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
    console.log(`审计文件: ${auditPath.pathname.replace(/^\//, '')}`);
    console.log('完成 ✅');
  } else {
    console.log('\n[DRY-RUN] 未写入。加 --apply 参数执行实际写入。');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
