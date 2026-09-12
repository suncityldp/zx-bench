import { describe, it, expect, vi } from 'vitest';
import { createDockerReadiness, isDockerInfrastructureFailure } from './dockerReadiness.js';

describe('Docker readiness lifecycle', () => {
  it('rechecks a previously healthy daemon and starts it after a crash', async () => {
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const start = vi.fn().mockResolvedValue(true);
    const check = createDockerReadiness({ probe, start });
    expect(await check()).toBe(true);
    expect(await check()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent callers and backs off failed Desktop launches', async () => {
    let time = 100;
    const probe = vi.fn().mockResolvedValue(false);
    const start = vi.fn().mockResolvedValue(false);
    const check = createDockerReadiness({ probe, start, now: () => time, cooldownMs: 30 });
    expect(await Promise.all([check(), check(), check()])).toEqual([false, false, false]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await check()).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    // Manual recovery is detected even during the launch cooldown.
    probe.mockResolvedValueOnce(true);
    expect(await check()).toBe(true);
    time += 31;
    expect(await check()).toBe(false);
    expect(start).toHaveBeenCalledTimes(2);
  });
  it('does not mistake candidate compile failures for Docker loss', () => {
    expect(isDockerInfrastructureFailure(['compilation failed'])).toBe(false);
    expect(isDockerInfrastructureFailure(['ENVIRONMENT_ERROR: docker daemon unreachable'])).toBe(true);
    expect(isDockerInfrastructureFailure(['EVALUATION_FAILED: Error: DOCKER_NOT_READY: unavailable'])).toBe(true);
  });
});
