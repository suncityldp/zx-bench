import { describe, expect, it } from 'vitest';
import { dockerDesktopPathCandidates, shouldAutoStartDockerDesktop, resolveContainerImage } from './containerRunner.js';

it('resolves only the exact frozen Go image identity', () => {
  expect(resolveContainerImage('zxbench/go@sha256:bbe499b0985c0481a47548381d03e2a46ded78e13411b8e5865b0efbdb391e03')).toBe('zxbench/go:1.21-gcc');
  for (const image of ['zxbench/go@sha256:unknown', 'node@sha256:unknown', 'toString', 'zxbench/go:1.21-gcc']) {
    expect(resolveContainerImage(image)).toBe(image);
  }
});

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
