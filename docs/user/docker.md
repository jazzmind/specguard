---
title: "Docker Runner Adapter"
sidebar_label: "Docker Runner Adapter"
generated: true
---

# Docker Runner Adapter

## Overview

The Docker Runner Adapter is the component responsible for executing containerised security tools — including Semgrep, Bandit, and OWASP ZAP — within SpecGuard pipelines. It provides a clean, consistent interface for running Docker containers without requiring individual pipelines to manage low-level Docker invocations directly.

If you are building or configuring a pipeline that needs to run a containerised tool, this adapter is the correct way to do it.

---

## What It Does

The adapter handles two core responsibilities:

**Checking Docker availability** — Before attempting to run anything, you can ask the adapter whether Docker is accessible in the current environment. This check is safe to call at any time; it will never throw an error regardless of the environment state.

**Running containers** — The adapter executes containers using `docker run --rm`, meaning containers are automatically cleaned up after they finish. You provide the image, any arguments, file mounts, and environment variables, and the adapter takes care of the rest.

---

## Running a Container

When you invoke `runContainer`, you supply an options object describing:

- **Image and tag** — the Docker image to run.
- **Arguments** — any command-line arguments to pass to the container.
- **Volume mounts** — pairs of host and container paths, for example `{ host: '/my/project', container: '/src' }`. These are translated automatically to the appropriate `-v` flags.
- **Environment variables** — pairs of names and values, for example `{ name: 'LOG_LEVEL', value: 'debug' }`. These are translated to `-e` flags.

The call returns a `ContainerResult` object with the following fields:

| Field | Type | Description |
|---|---|---|
| `stdout` | `string` | Standard output from the container |
| `stderr` | `string` | Standard error from the container |
| `exitCode` | `number` | The exit code returned by the container process |
| `ok` | `boolean` | `true` only if Docker was available and the container exited with code zero |

---

## Timeouts

Each container run has a configurable timeout, with a default of **120 seconds**. If a container is still running when the timeout expires, it is terminated and the call returns a result with `ok: false`. You can adjust this timeout when invoking the adapter if your tool is expected to take longer or you want a shorter limit.

---

## Behaviour When Docker Is Unavailable

The adapter is designed to degrade gracefully. If Docker is not available in the environment — for example, in a CI context where the Docker daemon is not running — `runContainer` will return immediately with the following result rather than throwing an exception:

```
{ stdout: '', stderr: '', exitCode: -1, ok: false }
```

This means your pipeline can always inspect the `ok` field and handle the unavailable case without wrapping calls in try/catch blocks.

---

## Checking Docker Availability Directly

If you need to know whether Docker is available before attempting a run — for example, to skip an entire pipeline stage gracefully — you can call `isDockerAvailable()`. It returns `true` when Docker is accessible and `false` otherwise. It will never throw.

---

## Important: Always Use This Adapter

Any pipeline that needs to execute a containerised tool **must route through this adapter**. Calling Docker directly (for example, via `spawnSync('docker', ...)`) is not permitted. The adapter ensures consistent timeout handling, result formatting, and graceful degradation across all pipelines.

---

## Testing

The adapter exports a `dockerRunner` seam that allows it to be replaced in tests. This means you can write unit tests for pipelines that depend on container execution without requiring a live Docker environment.
