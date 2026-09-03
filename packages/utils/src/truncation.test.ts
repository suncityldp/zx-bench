import { describe, expect, it } from 'vitest';
import { buildOutputMetadata } from './truncation.js';

describe('buildOutputMetadata', () => {
  it('does not treat a complete short answer without a conclusion label as truncated', () => {
    const metadata = buildOutputMetadata('北京。', 'stop', 8192, 2);
    expect(metadata.containsFinalConclusion).toBe(false);
    expect(metadata.incomplete).toBe(false);
    expect(metadata.incompleteReasons).toBeUndefined();
  });

  it('keeps genuine length truncation marked incomplete', () => {
    const metadata = buildOutputMetadata('正在继续', 'length', 100, 100);
    expect(metadata.truncated).toBe(true);
    expect(metadata.incomplete).toBe(true);
    expect(metadata.incompleteReasons).toContain('finish_reason is length (hit max_tokens)');
  });
});
