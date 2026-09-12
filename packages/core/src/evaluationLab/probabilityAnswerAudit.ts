/** Answer integrity and resource cleanup are independent acceptance checks. */
export function probabilityAnswerAuditStatus(status: Record<string, unknown>) {
  if (status.completed_requests !== 12) throw new Error('Twelve completed answers required');
  if (status.state === 'completed' && status.all_models_unloaded === true) {
    return {answerCountComplete: true, cleanupConfirmed: true, terminalStatus: status};
  }
  if (status.state === 'blocked' && status.error === 'HTTP Error 401: Unauthorized' &&
      status.planned_requests === 12 && status.automatic_retries === 0 &&
      status.cleanup === 'unconfirmed_no_force_unload_or_foreign_cancellation') {
    return {answerCountComplete: true, cleanupConfirmed: false, terminalStatus: status};
  }
  throw new Error('Unknown or nonterminal run state; do not infer answer validity');
}
