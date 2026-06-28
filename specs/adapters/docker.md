# Docker Runner Adapter

<!-- module: src/adapters/docker.ts -->
<!-- type: adapter -->
<!-- status: stable -->

## Overview

The Docker adapter is the execution layer for running containerised external tools
(Semgrep, Bandit, OWASP ZAP). It abstracts `docker run --rm` invocations behind a
typed interface, handles availability probing, volume mounts, and graceful degradation
when Docker is unavailable.

All pipelines that need to shell out to a container (e.g. security) must route through
this adapter — never call `spawnSync('docker', ...)` directly.

## Acceptance Criteria

- `isDockerAvailable()` returns `true` when `docker info` exits with code 0, `false` otherwise. Never throws.
- `runContainer(opts)` executes `docker run --rm` with the provided image/tag, volumes, args, and env vars.
- `runContainer` returns `ContainerResult { stdout, stderr, exitCode, ok }`. `ok` is `false` when Docker is unavailable or the container exits non-zero.
- Volume mounts are passed as `{ host, container }` pairs and translated to `-v host:container`.
- Env vars are passed as `{ name, value }` pairs and translated to `-e name=value`.
- A configurable timeout (default 120 s) terminates the container and returns `ok: false`.
- When Docker is unavailable, `runContainer` returns `{ stdout: '', stderr: '', exitCode: -1, ok: false }` without throwing.
- The adapter is testable via the `dockerRunner` seam exported from the module.

## Scenarios

### Scenario 1: Docker available, container succeeds
**Steps:**
1. Call `runContainer` with a valid image and args
2. Docker runs and exits 0

**Expected Results:**
- Returns `{ ok: true, exitCode: 0, stdout: <output>, stderr: '' }`

### Scenario 2: Docker unavailable
**Steps:**
1. Docker is not installed or daemon is not running
2. Call `runContainer`

**Expected Results:**
- Returns `{ ok: false, exitCode: -1, stdout: '', stderr: '' }` without throwing

### Scenario 3: Container exits non-zero
**Steps:**
1. Call `runContainer` with args that cause the container to exit 1

**Expected Results:**
- Returns `{ ok: false, exitCode: 1, stdout: <output>, stderr: <error> }`

### Scenario 4: isDockerAvailable probing
**Steps:**
1. Call `isDockerAvailable()` when `docker info` succeeds

**Expected Results:**
- Returns `true`

## Security Notes

- Never pass credentials as Docker `--env` flags in log output — redact before logging.
- Volume mounts are always read-only from the host (`-v host:container:ro`) for analysis containers.
- Do not allow callers to inject arbitrary Docker flags (only typed opts).

## Dependencies

- Node.js `child_process.spawnSync`
- No external npm packages
