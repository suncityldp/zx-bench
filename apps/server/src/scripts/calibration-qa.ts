import { getCalibrationStore } from '../calibration/store.js';
import { analyzeRubricQuality } from '@zxbench/core';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { withCurrentSourceStatus } from '../calibration/routes.js';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL || `file:${fileURLToPath(new URL('../../../data/zxbench.db', import.meta.url))}` } } });
const store = getCalibrationStore();
try {
  const records = await withCurrentSourceStatus(store.list(), prisma);
  console.log(JSON.stringify({ ...analyzeRubricQuality(records), storedCandidates: store.count(), inspectedCandidates: records.length }, null, 2));
} finally { store.close(); await prisma.$disconnect(); }
