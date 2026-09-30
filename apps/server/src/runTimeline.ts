// ============================================================
// run 时间轴统计（P1 修复，2026-09-18）
//
// 背景：原实现 `pausedMs = max(0, 墙钟 − Σ单题耗时)`。
// Σ单题耗时在 `parallelism ≥ 2` 时天然约为墙钟的 p 倍（并行题目的执行区间互相重叠），
// 所以这个差值**恒为负、pausedMs 恒为 0** —— 实测 09-17 的 5 维 run（parallelism=2）
// 真实经历了 2 次 resume + 1 次进程重启（含 17.9 分钟空档），仍然报 `pausedMs = 0`
// （`durationMs` 5.95h vs `executionMs` 11.42h）。该字段因此无法用于任何判断。
//
// 正确口径：把「至少有一题在执行」的墙钟时长算成**区间并集**，
//   pausedMs = 墙钟 − 并集
// 并集对 parallelism 免疫，且恰好就是"机器真正在跑评测"的时间。
//
// 纯函数，便于单测（见 runTimeline.test.ts）。
// ============================================================

export interface RunTimelineSpan {
  /** epoch ms */
  start: number;
  /** epoch ms */
  end: number;
}

export interface RunTimelineStats {
  /** 最早一题开始时间（无有效结果时退回 fallbackStart） */
  firstStartedAt: number;
  /** 各题执行跨度之和（并行时含重叠；保留旧语义供报告侧使用） */
  executionMs: number | null;
  /** 墙钟 = finishedAt − firstStartedAt */
  wallClockMs: number;
  /** 区间并集 = 至少有一题在执行的真实时长 */
  activeMs: number | null;
  /** 中断/暂停空档 = 墙钟 − activeMs（恒非负） */
  /** Uncovered wall-clock gaps, including queues/interruption; not measured user pauses. */
  pausedMs: number | null;
  /** 执行段数：相邻执行区间间隔 > 60s 记一次中断（1 = 从未中断） */
  resumeCount: number | null;
  timingBasis: 'question-span-union' | 'unknown';
  timingCoverage: number;
  /** 与 wallClockMs 同义，保留旧字段名 */
  durationMs: number;
}

/** 判定「另起一段执行」的最小空档 */
const RESUME_GAP_MS = 60_000;

export function computeRunTimeline(
  spans: RunTimelineSpan[],
  fallbackStart: number,
  finishedAt: number,
): RunTimelineStats {
  const valid = spans
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
    .sort((a, b) => a.start - b.start);

  if (valid.length === 0) {
    // 没有任何可用的题级时间轴：无法区分执行与空档，按"全程执行"处理（不虚报暂停）。
    const wallClockMs = Math.max(0, finishedAt - fallbackStart);
    return {
      firstStartedAt: fallbackStart,
      executionMs: null,
      wallClockMs,
      activeMs: null,
      pausedMs: null,
      resumeCount: null,
      timingBasis: 'unknown',
      timingCoverage: 0,
      durationMs: wallClockMs,
    };
  }

  const firstStartedAt = valid[0].start;
  const executionMs = valid.reduce((acc, s) => acc + (s.end - s.start), 0);
  const wallClockMs = Math.max(0, finishedAt - firstStartedAt);

  // 区间并集 + 执行段计数：同一遍扫描完成（输入已按 start 排序）
  let activeMs = 0;
  let resumeCount = 1;
  let cursorStart = valid[0].start;
  let cursorEnd = valid[0].end;
  for (const s of valid.slice(1)) {
    if (s.start > cursorEnd) {
      activeMs += cursorEnd - cursorStart;
      if (s.start > cursorEnd + RESUME_GAP_MS) resumeCount += 1;
      cursorStart = s.start;
      cursorEnd = s.end;
      continue;
    }
    if (s.end > cursorEnd) cursorEnd = s.end;
  }
  activeMs += cursorEnd - cursorStart;

  return {
    firstStartedAt,
    executionMs,
    wallClockMs,
    activeMs,
    pausedMs: Math.max(0, wallClockMs - activeMs),
    resumeCount,
    timingBasis: 'question-span-union',
    timingCoverage: valid.length / spans.length,
    durationMs: wallClockMs,
  };
}
