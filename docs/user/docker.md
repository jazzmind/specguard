---
title: "Docker Runner Adapter"
sidebar_label: "Docker Runner Adapter"
description: "The Docker Runner Adapter provides a typed, safe interface for running containerised tools like Semgrep, Bandit, and OWASP ZAP, handling availability checks, volume mounts, environment variables, and graceful degradation when Docker is unavailable."
category: "adapters"
order: 10
generated: true
---

# Docker Runner Adapter

The Docker Runner Adapter is the execution layer SpecGuard uses to run containerised external tools — including Semgrep, Bandit, and OWASP ZAP. Rather than calling Docker directly from pipeline code, all container-based pipelines route through this adapter, which provides a clean, typed interface, handles availability probing, and degrades gracefully when Docker is not present in the environment.

> **Note:** Never call `docker run` (or `spawnSync('docker', ...)`) directly from a pipeline. Always use this adapter.

---

## How It Works

The adapter wraps `docker run --rm` invocations behind two primary functions: `isDockerAvailable()` and `runContainer(opts)`. It has no external npm dependencies — only Node.js's built-in `child_process.spawnSync` is used under the hood.

---

## Checking Docker Availability

Before running any container, you can check whether Docker is accessible in the current environment:

```ts
import { isDockerAvailable } from './dockerRunner';

const available = isDockerAvailable();
// true  → Docker is running and reachable
// false → Docker is unavailable (never throws)
```

`isDockerAvailable()` runs `docker info` internally. It returns `true` if the command exits with code `0`, and `false` in all other cases. It will **never throw** — making it safe to call at any point without a try/catch.

---

## Running a Container

Use `runContainer(opts)` to execute a Docker container. The function always returns a `ContainerResult` object and never throws, even when Docker is unavailable.

### Return Type

```ts
interface ContainerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
}
```

- **`ok`** is `true` only when Docker is available **and** the container exits with code `0`.
- **`ok`** is `false` if Docker is unavailable, the container exits non-zero, or the run times out.

### Options

| Option | Type | Description |
|---|---|---|
| `image` | `string` | The Docker image name and tag to run. |
| `args` | `string[]` | Arguments passed to the container's entrypoint. |
| `volumes` | `{ host: string; container: string }[]` | Host-to-container path mappings. |
| `env` | `{ name: string; value: string }[]` | Environment variables to inject into the container. |
| `timeout` | `number` _(optional)_ | Timeout in milliseconds. Defaults to **120 seconds**. |

### Volume Mounts

Volumes are specified as `{ host, container }` pairs and are translated to `-v host:container` flags automatically:

```ts
volumes: [
  { host: '/workspace/src', container: '/src' }
]
// → docker run --rm -v /workspace/src:/src ...
```

### Environment Variables

Environment variables are specified as `{ name, value }` pairs and translated to `-e name=value` flags:

```ts
env: [
  { name: 'SCAN_TARGET', value: '/src' }
]
// → docker run --rm -e SCAN_TARGET=/src ...
```

### Timeout Behaviour

If the container does not complete within the configured timeout (default: **120 seconds**), the adapter terminates the container and returns:

```ts
{ stdout: '', stderr: '', exitCode: -1, ok: false }
```

### When Docker Is Unavailable

If Docker is not available, `runContainer` returns the following immediately — without throwing:

```ts
{ stdout: '', stderr: '', exitCode: -1, ok: false }
```

This allows pipelines to handle degraded environments gracefully (e.g. skipping a scan step and reporting it as unavailable rather than crashing).

---

## Example Usage

```ts
import { runContainer } from './dockerRunner';

const result = await runContainer({
  image: 'returntocorp/semgrep:latest',
  args: ['--config', 'auto', '/src'],
  volumes: [{ host: '/workspace/src', container: '/src' }],
  env: [{ name: 'LOG_LEVEL', value: 'info' }],
  timeout: 90_000, // 90 seconds
});

if (!result.ok) {
  console.error('Scan failed or Docker unavailable:', result.stderr);
} else {
  console.log('Scan output:', result.stdout);
}
```

---

## Testing

The adapter exports a `dockerRunner` seam that you can use to inject a mock or stub in tests — no need to have Docker running in your CI environment to unit-test pipeline logic:

```ts
import { dockerRunner } from './dockerRunner';

// Replace with a test double in your test setup
dockerRunner.run = jest.fn().mockResolvedValue({
  stdout: '<mock output>',
  stderr: '',
  exitCode: 0,
  ok: true,
});
```

---

## Dependencies

The Docker Runner Adapter has no external npm dependencies. It relies solely on Node.js's built-in `child_process.spawnSync`.
