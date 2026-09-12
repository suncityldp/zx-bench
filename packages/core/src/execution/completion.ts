import { randomUUID } from 'node:crypto';

/** Completion evidence catches premature successful exits, not adversarial harness forgery.
 * Candidate and assertions still share a process; this is not a security boundary. */
export function completionToken(): string {
  return `ZXBENCH_COMPLETED_${randomUUID().replaceAll('-', '')}`;
}

export function completed(stdout: string, token: string): boolean {
  return stdout.split(/\r?\n/).some(line => line === token);
}
