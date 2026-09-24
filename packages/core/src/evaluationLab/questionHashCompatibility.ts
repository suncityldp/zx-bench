/**
 * Frozen progressive runs may predate a non-scoring hard-time-limit wording
 * change. Treat that historical text-only drift as compatible, but fail closed
 * for every other prompt difference.
 */
export function differsOnlyByHardTimeLimit(frozenPrompt: string, currentPrompt: string): boolean {
  const limit = /时限(\d+)秒/g;
  const frozenLimits = [...frozenPrompt.matchAll(limit)];
  const currentLimits = [...currentPrompt.matchAll(limit)];
  if (frozenLimits.length !== 1 || currentLimits.length !== 1
    || frozenLimits[0][1] === currentLimits[0][1]) return false;
  return frozenPrompt.replace(limit, '时限<T>秒') === currentPrompt.replace(limit, '时限<T>秒');
}
