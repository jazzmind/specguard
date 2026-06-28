import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dockerRunner, isDockerAvailable, runContainer } from '../../src/adapters/docker.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('isDockerAvailable', () => {
  it('returns true when docker info exits 0', async () => {
    vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: '28.0.0',
      stderr: '',
      status: 0,
    });
    expect(await isDockerAvailable()).toBe(true);
  });

  it('returns false when docker info exits non-zero', async () => {
    vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: '',
      stderr: 'Cannot connect to Docker daemon',
      status: 1,
    });
    expect(await isDockerAvailable()).toBe(false);
  });

  it('returns false when spawn errors (Docker not installed)', async () => {
    vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: null,
      stderr: null,
      status: null,
      error: new Error('spawn docker ENOENT'),
    });
    expect(await isDockerAvailable()).toBe(false);
  });
});

describe('runContainer', () => {
  it('scenario 1: returns ok result when container exits 0', async () => {
    vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: '{"results":[]}',
      stderr: '',
      status: 0,
    });

    const result = await runContainer({
      image: 'semgrep/semgrep',
      tag: '1.78.0',
      args: ['--version'],
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"results":[]}');
  });

  it('scenario 2: returns ok:false when Docker not available (spawn error)', async () => {
    vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: null,
      stderr: null,
      status: null,
      error: new Error('spawn docker ENOENT'),
    });

    const result = await runContainer({ image: 'semgrep/semgrep', args: [] });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toBe('');
  });

  it('scenario 3: returns ok:false when container exits non-zero', async () => {
    vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: '',
      stderr: 'Fatal: scan failed',
      status: 2,
    });

    const result = await runContainer({ image: 'myimage' });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('Fatal: scan failed');
  });

  it('builds volume mount args correctly', async () => {
    const spawnSpy = vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: '',
      stderr: '',
      status: 0,
    });

    await runContainer({
      image: 'semgrep/semgrep',
      tag: '1.78.0',
      volumes: [
        { host: '/project/src', container: '/src', mode: 'ro' },
        { host: '/project/rules', container: '/rules', mode: 'ro' },
      ],
      args: ['semgrep', '--json', '/src'],
    });

    const calledArgs = spawnSpy.mock.calls[0][0];
    expect(calledArgs).toContain('-v');
    expect(calledArgs).toContain('/project/src:/src:ro');
    expect(calledArgs).toContain('/project/rules:/rules:ro');
    expect(calledArgs).toContain('semgrep/semgrep:1.78.0');
  });

  it('builds env var args correctly', async () => {
    const spawnSpy = vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: '',
      stderr: '',
      status: 0,
    });

    await runContainer({
      image: 'myimage',
      env: [{ name: 'FOO', value: 'bar' }],
    });

    const calledArgs = spawnSpy.mock.calls[0][0];
    expect(calledArgs).toContain('-e');
    expect(calledArgs).toContain('FOO=bar');
  });

  it('defaults tag to latest', async () => {
    const spawnSpy = vi.spyOn(dockerRunner, 'spawn').mockReturnValueOnce({
      stdout: '',
      stderr: '',
      status: 0,
    });

    await runContainer({ image: 'myimage' });

    const calledArgs = spawnSpy.mock.calls[0][0];
    expect(calledArgs).toContain('myimage:latest');
  });
});
