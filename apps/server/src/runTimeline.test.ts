// 2026-09-18：run 时间轴统计的回归测试。
// 核心是修掉「parallelism ≥ 2 时 pausedMs 恒为 0」——旧公式 pausedMs = max(0, 墙钟 − Σ单题耗时)
// 在并行下必然为负，实测一个真实经历 2 次 resume 的 run 仍报 0（5.95h vs 11.42h）。
import { describe, expect, it } from 'vitest';
import { computeRunTimeline } from './runTimeline.js';

const MIN = 60_000;
const H = 3_600_000;

describe('computeRunTimeline', () => {
  it('串行、无空档：pausedMs 为 0，resumeCount 为 1', () => {
    const spans = [{ start: 0, end: 10 * MIN }, { start: 10 * MIN, end: 25 * MIN }];
    const t = computeRunTimeline(spans, 0, 25 * MIN);
    expect(t.firstStartedAt).toBe(0);
    expect(t.wallClockMs).toBe(25 * MIN);
    expect(t.activeMs).toBe(25 * MIN);
    expect(t.pausedMs).toBe(0);
    expect(t.resumeCount).toBe(1);
    expect(t.durationMs).toBe(t.wallClockMs);
  });

  // 回归：旧公式在 parallelism=2 时把真实 20 分钟暂停报成 0
  it('并行重叠 + 真实空档：空档必须被计入 pausedMs（旧公式此处恒为 0）', () => {
    const spans = [
      { start: 0, end: 30 * MIN },            // worker A 第一段
      { start: 5 * MIN, end: 35 * MIN },      // worker B 第一段（与 A 重叠）
      { start: 55 * MIN, end: 70 * MIN },     // 空档 20 分钟后恢复
      { start: 60 * MIN, end: 80 * MIN },
    ];
    const t = computeRunTimeline(spans, 0, 80 * MIN);
    // 旧口径：executionMs = 30+30+15+20 = 95min > 墙钟 80min ⇒ max(0, −15min) = 0
    expect(t.executionMs).toBe(95 * MIN);
    expect(t.pausedMs).toBe(20 * MIN);        // 35min → 55min 的 20 分钟空档
    expect(t.activeMs).toBe(60 * MIN);
    expect(t.resumeCount).toBe(2);
  });

  // 语义约定：只有「大于 60s」的空档才算暂停/中断（与 resumeCount 用同一阈值）；
  // 更短的间隔视为调度抖动，并入 activeMs —— 否则并行调度下每秒都会报"暂停"。
  it('不超过 60s 的空档不算暂停（视作调度抖动，并入 activeMs）', () => {
    const spans = [{ start: 0, end: 10 * MIN }, { start: 10 * MIN + 30_000, end: 20 * MIN }];
    const t = computeRunTimeline(spans, 0, 20 * MIN);
    expect(t.pausedMs).toBe(30_000);
    expect(t.activeMs).toBe(20 * MIN - 30_000);
    expect(t.resumeCount).toBe(1);
  });

  it('大于 60s 的空档计入 pausedMs 并另起一个执行段', () => {
    const spans = [{ start: 0, end: 10 * MIN }, { start: 10 * MIN + 90_000, end: 20 * MIN }];
    const t = computeRunTimeline(spans, 0, 20 * MIN);
    expect(t.pausedMs).toBe(90_000);
    expect(t.activeMs).toBe(20 * MIN - 90_000);
    expect(t.resumeCount).toBe(2);
  });

  it('恰好 60s 的空档不算中断（阈值是「大于」）', () => {
    const spans = [{ start: 0, end: 10 * MIN }, { start: 11 * MIN, end: 20 * MIN }];
    const exact = computeRunTimeline(spans, 0, 20 * MIN);
    expect(exact.resumeCount).toBe(1);
    expect(exact.pausedMs).toBe(MIN);
    const spans2 = [{ start: 0, end: 10 * MIN }, { start: 11 * MIN + 1, end: 20 * MIN }];
    expect(computeRunTimeline(spans2, 0, 20 * MIN).resumeCount).toBe(2);
  });

  it('包含关系的区间只算一次（并集，不是简单相加）', () => {
    const spans = [{ start: 0, end: 60 * MIN }, { start: 10 * MIN, end: 20 * MIN }];
    const t = computeRunTimeline(spans, 0, 60 * MIN);
    expect(t.activeMs).toBe(60 * MIN);
    expect(t.executionMs).toBe(70 * MIN);   // 旧语义：跨度之和（含重叠）
    expect(t.pausedMs).toBe(0);
  });

  it('乱序输入不影响结果', () => {
    const ordered = computeRunTimeline([{ start: 0, end: 10 * MIN }, { start: 40 * MIN, end: 50 * MIN }], 0, 50 * MIN);
    const shuffled = computeRunTimeline([{ start: 40 * MIN, end: 50 * MIN }, { start: 0, end: 10 * MIN }], 0, 50 * MIN);
    expect(shuffled).toEqual(ordered);
    expect(shuffled.pausedMs).toBe(30 * MIN);
  });

  it('没有可用结果时退回 fallbackStart，且不虚报暂停', () => {
    const t = computeRunTimeline([], 1000, 1000 + 2 * H);
    expect(t.firstStartedAt).toBe(1000);
    expect(t.wallClockMs).toBe(2 * H);
    expect(t.pausedMs).toBeNull();
    expect(t.activeMs).toBeNull();
    expect(t.executionMs).toBeNull();
    expect(t.resumeCount).toBeNull();
    expect(t.timingCoverage).toBe(0);
  });

  it('丢弃非法跨度（end < start / NaN）', () => {
    const t = computeRunTimeline(
      [{ start: 0, end: 10 * MIN }, { start: 20 * MIN, end: 10 * MIN }, { start: NaN, end: 5 }],
      0,
      10 * MIN,
    );
    expect(t.activeMs).toBe(10 * MIN);
    expect(t.pausedMs).toBe(0);
  });
});
