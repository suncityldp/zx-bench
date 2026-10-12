import { describe, expect, it, vi } from 'vitest';
import { assertScenarioImagesReady, scenarioImageContracts } from './imagePreflight.js';

describe('frozen scenario image preflight', () => {
  it('collects runtime defaults without scanning fixtures or assuming an entire dimension needs Docker', () => {
    expect(scenarioImageContracts({ executionCases: [{}], executionWorld: { expectedImageId: 'frozen' },
      agentLoop: { backend: 'docker' }, files: [{ content: 'image: imaginary' }] })).toEqual([
      { image: 'python:3.12-alpine', expectedImageId: undefined },
      { image: 'python:3.12-alpine', expectedImageId: 'frozen' },
      { image: 'node:22-alpine', expectedImageId: undefined },
    ]);
    expect(scenarioImageContracts({ agentLoop: { backend: 'local' } })).toEqual([]);
  });
  it('checks IDs on every invocation, caches only duplicate inspect in one invocation and pauses on drift', async () => {
    const inspect = vi.fn().mockResolvedValue({ status: 0, stdout: '[{"Id":"frozen","Os":"linux"}]', stderr: '' });
    const rows = [{ image: 'python:test', expectedImageId: 'frozen' }, { image: 'python:test' }];
    await assertScenarioImagesReady(rows, inspect);
    expect(inspect).toHaveBeenCalledTimes(1);
    inspect.mockResolvedValue({ status: 0, stdout: '[{"Id":"moved","Os":"linux"}]', stderr: '' });
    await expect(assertScenarioImagesReady(rows, inspect)).rejects.toThrow('DOCKER_NOT_READY: Image ID mismatch');
    expect(inspect).toHaveBeenCalledTimes(2);
  });
  it('treats missing images and malformed inspect as infrastructure failures without pulling', async () => {
    for (const result of [{ status: 1, stdout: '', stderr: 'No image' }, { status: 0, stdout: '[]', stderr: '' }]) {
      const inspect = vi.fn().mockResolvedValue(result);
      await expect(assertScenarioImagesReady([{ image: 'python:test' }], inspect)).rejects.toThrow('DOCKER_NOT_READY:');
      expect(inspect).toHaveBeenCalledWith(['image', 'inspect', 'python:test']);
    }
  });
});
