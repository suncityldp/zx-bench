// 从 benchmark.json 重新生成 benchmark-meta.json 中可推导的字段。
// 与 refresh-benchmark-hashes.mjs 同一思路：能推导的就不要手写，避免与题集漂移。
// 用法: node scripts/refresh-benchmark-meta.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { benchmarkCounts } from './benchmark-counts.mjs';

const root = new URL('../', import.meta.url);
const packPath = new URL('data/scenarios/benchmark.json', root);
const metaPath = new URL('data/scenarios/benchmark-meta.json', root);

const pack = JSON.parse(readFileSync(packPath, 'utf8'));
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

const valid = pack.filter((s) => s.status === 'valid');

const before = {
  count: meta.count,
  validCount: meta.validCount,
  totalCount: meta.totalCount,
  defaultRunCount: meta.defaultRunCount,
  dimensions: meta.dimensions,
};

const archive = JSON.parse(readFileSync(new URL('data/scenarios/archive/benchmark-retired.json', root), 'utf8'));
Object.assign(meta, benchmarkCounts(pack, archive));
meta.countSemantics = { currentRecordCount: 'All records in benchmark.json (valid and retired)', retiredCount: 'Retired records retained in benchmark.json', archivedRetiredCount: 'Disjoint retired records in archive/benchmark-retired.json', totalCount: 'currentRecordCount + archivedRetiredCount', defaultRunCount: 'Valid current records excluding developmentShadow; execution migration instances excluded' };

writeFileSync(metaPath, `${JSON.stringify(meta, null, 1)}\n`, 'utf8');
console.log(JSON.stringify({ totalRecords: pack.length, valid: valid.length, before, after: {
  count: meta.count, validCount: meta.validCount, totalCount: meta.totalCount,
  defaultRunCount: meta.defaultRunCount, dimensions: meta.dimensions,
} }, null, 2));
