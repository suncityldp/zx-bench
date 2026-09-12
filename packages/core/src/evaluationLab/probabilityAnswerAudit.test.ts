import {describe, expect, it} from 'vitest';
import {probabilityAnswerAuditStatus} from './probabilityAnswerAudit.js';
const cleanupFailure = {state: 'blocked', error: 'HTTP Error 401: Unauthorized', completed_requests: 12,
  planned_requests: 12, automatic_retries: 0, cleanup: 'unconfirmed_no_force_unload_or_foreign_cancellation'};
describe('answer-only audit terminal gate', () => {
  it('retains cleanup failure rather than promoting it to successful cleanup', () => {
    expect(probabilityAnswerAuditStatus(cleanupFailure)).toEqual({answerCountComplete: true, cleanupConfirmed: false, terminalStatus: cleanupFailure});
  });
  it('accepts completed clean runs', () => {
    expect(probabilityAnswerAuditStatus({state: 'completed', completed_requests: 12, all_models_unloaded: true}).cleanupConfirmed).toBe(true);
  });
  it.each([
    {...cleanupFailure, completed_requests: 11}, {...cleanupFailure, state: 'running'},
    {...cleanupFailure, error: 'unknown'}, {...cleanupFailure, automatic_retries: 1},
    {...cleanupFailure, cleanup: 'unknown'}, {...cleanupFailure, planned_requests: 14},
    {state: 'completed', completed_requests: 12, all_models_unloaded: false},
  ])('rejects incomplete, nonterminal and unrecognized status: %j', status => {
    expect(() => probabilityAnswerAuditStatus(status)).toThrow();
  });
});
