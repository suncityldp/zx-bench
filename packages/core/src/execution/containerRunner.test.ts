import { describe, expect, it } from 'vitest';
import { dockerDesktopPathCandidates, shouldAutoStartDockerDesktop } from './containerRunner.js';

describe('Docker Desktop startup policy', () => {
  it('only enables automatic Desktop launch on Windows unless explicitly disabled', () => {
    expect(shouldAutoStartDockerDesktop('win32', false)).toBe(true);
    expect(shouldAutoStartDockerDesktop('win32', true)).toBe(false);
    expect(shouldAutoStartDockerDesktop('linux', false)).toBe(false);
  });

  it('includes an explicitly configured executable before Windows default paths', () => {
    expect(dockerDesktopPathCandidates('win32', 'D:\\Tools\\Docker Desktop.exe')).toEqual([
      'D:\\Tools\\Docker Desktop.exe',
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      'C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe',
    ]);
    expect(dockerDesktopPathCandidates('linux', '/usr/bin/docker-desktop')).toEqual([]);
  });
});
