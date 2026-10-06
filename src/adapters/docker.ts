/**
 * Docker runner adapter.
 *
 * Wraps `docker run --rm` behind a typed interface so pipelines never call
 * spawnSync('docker', ...) directly. Handles availability probing, volume
 * mounts, env vars, and graceful degradation when Docker is unavailable.
 *
 * Spec: specs/adapters/docker.md
 *
 * Testability seam
 * ----------------
 * All internal `spawnSync` calls go through the exported `dockerRunner` object
 * so tests can stub them with `vi.spyOn(dockerRunner, 'spawn')`.
 */
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single volume mount: host path → container path. */
export interface VolumeMount {
  host: string;
  container: string;
  /** Default: 'ro'. Pass 'rw' for writable mounts (e.g. output dirs). */
  mode?: 'ro' | 'rw';
}

/** An env var to inject into the container. */
export interface EnvVar {
  name: string;
  value: string;
}

/** Options for a single `docker run --rm` invocation. */
export interface DockerRunOpts {
  /** Docker image name without tag. */
  image: string;
  /** Image tag. Defaults to `latest`. */
  tag?: string;
  /** Volume mounts. All host → container:ro unless mode is overridden. */
  volumes?: VolumeMount[];
  /** Extra args appended after the image:tag. */
  args?: string[];
  /** Env vars injected with -e. */
  env?: EnvVar[];
  /** Timeout in milliseconds. Defaults to 120_000 (2 min). */
  timeoutMs?: number;
}

/** Result of a single container invocation. */
export interface ContainerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** `true` only when Docker was available and the container exited 0. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Runner seam (exported for test stubbing)
// ---------------------------------------------------------------------------

/** Spawn seam — tests replace `dockerRunner.spawn` with vi.spyOn. */
export const dockerRunner = {
  spawn(
    args: string[],
    timeoutMs: number,
  ): { stdout: string | null; stderr: string | null; status: number | null; error?: Error } {
    const res = spawnSync('docker', args, {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return {
      stdout: res.stdout as string | null,
      stderr: res.stderr as string | null,
      status: res.status,
      error: res.error,
    };
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the Docker daemon is reachable. Never throws.
 * Uses `docker info` as the probe (exits 0 when daemon is running).
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const res = dockerRunner.spawn(['info', '--format', '{{.ServerVersion}}'], 5_000);
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Run a Docker container and return its output.
 *
 * Returns `{ ok: false, exitCode: -1, stdout: '', stderr: '' }` when Docker is
 * unavailable or the spawn fails — never throws.
 */
export async function runContainer(opts: DockerRunOpts): Promise<ContainerResult> {
  const {
    image,
    tag = 'latest',
    volumes = [],
    args = [],
    env = [],
    timeoutMs = 120_000,
  } = opts;

  const dockerArgs: string[] = ['run', '--rm'];

  for (const v of volumes) {
    const mode = v.mode ?? 'ro';
    dockerArgs.push('-v', `${v.host}:${v.container}:${mode}`);
  }

  for (const e of env) {
    dockerArgs.push('-e', `${e.name}=${e.value}`);
  }

  dockerArgs.push(`${image}:${tag}`, ...args);

  try {
    const res = dockerRunner.spawn(dockerArgs, timeoutMs);

    if (res.error) {
      return { stdout: '', stderr: res.error.message, exitCode: -1, ok: false };
    }

    const exitCode = res.status ?? 1;
    const stdout = res.stdout ?? '';
    const stderr = res.stderr ?? '';

    return { stdout, stderr, exitCode, ok: exitCode === 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: message, exitCode: -1, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Long-lived containers (a Playwright server the host connects to)
// ---------------------------------------------------------------------------

export interface StartContainerOpts {
  image: string;
  tag?: string;
  /** Publish `container` on 127.0.0.1:`host`. */
  ports?: Array<{ host: number; container: number }>;
  env?: EnvVar[];
  /** Command and arguments after the image. */
  args?: string[];
  /** Make `host.docker.internal` resolve to the host on Linux too. */
  addHostGateway?: boolean;
  timeoutMs?: number;
}

export interface StartedContainer {
  ok: boolean;
  id?: string;
  stderr: string;
}

/** `docker run -d --rm`. Never throws; `ok` is false when Docker refused or is missing. */
export async function startContainer(opts: StartContainerOpts): Promise<StartedContainer> {
  const dockerArgs: string[] = ['run', '-d', '--rm'];
  for (const p of opts.ports ?? []) dockerArgs.push('-p', `127.0.0.1:${p.host}:${p.container}`);
  for (const e of opts.env ?? []) dockerArgs.push('-e', `${e.name}=${e.value}`);
  if (opts.addHostGateway) dockerArgs.push('--add-host', 'host.docker.internal:host-gateway');
  dockerArgs.push(`${opts.image}:${opts.tag ?? 'latest'}`, ...(opts.args ?? []));
  try {
    const res = dockerRunner.spawn(dockerArgs, opts.timeoutMs ?? 120_000);
    if (res.error) return { ok: false, stderr: res.error.message };
    const id = (res.stdout ?? '').trim().split('\n').pop()?.trim();
    if (res.status !== 0 || !id) return { ok: false, stderr: res.stderr ?? '' };
    return { ok: true, id, stderr: res.stderr ?? '' };
  } catch (err) {
    return { ok: false, stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** `docker stop` (the container was started with --rm). Never throws. */
export async function stopContainer(id: string): Promise<void> {
  try {
    dockerRunner.spawn(['stop', '-t', '2', id], 30_000);
  } catch {
    /* best-effort cleanup */
  }
}
