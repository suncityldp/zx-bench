// ============================================================
// 智秀大模型评测 WebUI — 后端服务入口
// Fastify + Prisma + WebSocket
// ============================================================

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { PrismaClient } from '@prisma/client';
import { registerRoutes } from './routes/index.js';
import { registerWebSocket } from './ws/index.js';
import { registerEvaluator, bugFindingEvaluator, codeRepairEvaluator, projectRepairEvaluator, structuredOutputEvaluator, dataExtractionEvaluator, exactAnswerLineEvaluator, instructionChecklistEvaluator, canaryAuthorityEvaluator, toolCallTraceEvaluator, agentTraceEvaluator, cliCommandEvaluator, hallucinationResistanceEvaluator, sandboxEvaluator, llmJudgeEvaluator } from '@zxbench/core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
// GPT5.6 P1-9: 默认绑定 127.0.0.1，仅本地访问
const HOST = process.env.ZXBENCH_HOST || '127.0.0.1';

// ===== 手动加载 apps/server/.env（DATABASE_URL 等），支持直接 node dist/index.js 启动 =====
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const raw of text.split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const c0 = val.charCodeAt(0);
    if (val.length >= 2 && (c0 === 34 || c0 === 39) && val.charCodeAt(val.length - 1) === c0) val = val.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv();

export const prisma = new PrismaClient();

// ===== SQLite WAL 模式：防止写入锁导致整个服务阻塞 =====
async function enableWAL() {
  try {
    // PRAGMA 在 SQLite 中会返回结果行，Prisma 的 $executeRawUnsafe 不支持，统一用 $queryRawUnsafe
    const walResult = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode=WAL');
    console.log(`✅ SQLite journal_mode=${walResult[0]?.journal_mode || 'unknown'}`);
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000');
    await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
    await prisma.$queryRawUnsafe('PRAGMA cache_size=-64000');
    await prisma.$queryRawUnsafe('PRAGMA foreign_keys=ON');
    console.log('✅ SQLite WAL 模式已启用 (busy_timeout=5000, synchronous=NORMAL)');
  } catch (err) {
    console.error('⚠️  无法启用 WAL 模式:', err);
  }
}

async function main() {
  await enableWAL();
  const app = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    },
  });

  // GPT5.6 P1-9: CORS 默认拒绝跨域，仅允许同源
  const corsOrigin = process.env.ZXBENCH_CORS_ORIGIN || false;
  await app.register(cors, { origin: corsOrigin });

  // WebSocket
  await app.register(fastifyWebSocket);

  // 静态文件（前端构建产物）
  const webDist = path.join(__dirname, '../../web/dist');
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    decorateReply: true,
  });

  // 注册评分器
  registerEvaluator(bugFindingEvaluator);
  registerEvaluator(codeRepairEvaluator);
  registerEvaluator(projectRepairEvaluator);
  registerEvaluator(structuredOutputEvaluator);
  registerEvaluator(dataExtractionEvaluator);
  registerEvaluator(exactAnswerLineEvaluator);
  registerEvaluator(instructionChecklistEvaluator);
  registerEvaluator(canaryAuthorityEvaluator);
  registerEvaluator(toolCallTraceEvaluator);
  registerEvaluator(agentTraceEvaluator);
  registerEvaluator(cliCommandEvaluator);
  registerEvaluator(hallucinationResistanceEvaluator);
  registerEvaluator(sandboxEvaluator);
  registerEvaluator(llmJudgeEvaluator);

  // API 路由
  await registerRoutes(app);

  // WebSocket
  await registerWebSocket(app);

  // SPA fallback
  app.setNotFoundHandler((_request, reply) => {
    reply.sendFile('index.html');
  });

  // 启动
  try {
    // ===== 启动恢复：标记孤儿 running 运行为 failed =====
    // 服务器重启后，所有内存中的 evalControllers 已丢失，
    // 数据库中有 'running' 状态的运行实际上是孤儿，需要标记为 'failed'
    try {
      await prisma.$connect();
      const orphanRuns = await prisma.evalRun.findMany({
        where: { status: 'running' },
        select: { id: true, name: true },
      });
      if (orphanRuns.length > 0) {
        console.log(`\n🔧 发现 ${orphanRuns.length} 个孤儿运行（状态为 running 但无控制器），标记为 failed`);
        for (const run of orphanRuns) {
          await prisma.evalRun.update({
            where: { id: run.id },
            data: { status: 'failed' },
          });
          console.log(`   → ${run.name} (${run.id}) 已标记为 failed`);
        }
      } else {
        console.log(`\n✅ 无孤儿运行，所有评测状态正常`);
      }
    } catch (err) {
      console.error('启动恢复检查失败:', err);
    }

    // ===== 优雅关闭 =====
    const shutdown = async (signal: string) => {
      console.log(`\n⚠️  收到 ${signal} 信号，正在优雅关闭...`);
      // 将所有 running 状态的运行标记为 failed
      try {
        const activeRuns = await prisma.evalRun.findMany({
          where: { status: 'running' },
          select: { id: true },
        });
        for (const run of activeRuns) {
          await prisma.evalRun.update({
            where: { id: run.id },
            data: { status: 'failed' },
          });
        }
        console.log(`   已将 ${activeRuns.length} 个运行中评测标记为 failed`);
      } catch (e) {
        console.error('   标记失败:', e);
      }
      await app.close();
      await prisma.$disconnect();
      console.log('   服务已关闭');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await app.listen({ port: PORT, host: HOST });
    console.log(`\n🚀 智秀大模型评测 WebUI 已启动`);
    console.log(`   前端: http://localhost:${PORT}`);
    console.log(`   API:  http://localhost:${PORT}/api`);
    console.log(`   WS:   ws://localhost:${PORT}/ws`);
    if (HOST === '0.0.0.0') {
      console.log(`   ⚠️  监听所有网络接口，请确保已启用认证和 CSRF 防护`);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// 进程级错误处理：防止未捕获的 Promise rejection 或异常导致服务器崩溃
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  Unhandled Promise Rejection (已捕获，不会退出):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception (已捕获，不会退出):', err);
});

main();
