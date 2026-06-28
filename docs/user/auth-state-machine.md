---
title: "Auth State Machine"
sidebar_label: "Auth State Machine"
description: "The Auth State Machine adapter handles deterministic, secure browser-based authentication for the validate pipeline, caching sessions per profile and keeping credentials safely isolated from logs and configuration values."
category: "adapters"
order: 50
generated: true
---

# Auth State Machine

The Auth State Machine provides deterministic, browser-based authentication for the **validate pipeline**. It manages the full login flow — from navigating to a login page through to a confirmed session — and caches the result so that each named auth profile only logs in once per run, no matter how many specs share it.

---

## How It Works

Authentication follows a fixed sequence of states:

```
NavigateToLogin → FillCredentials → WaitForResult → Success | 2FA | Failed
```

Each step is handled automatically. You define *what* to authenticate against (URLs, environment variable names) in your config; the state machine handles *how* to drive the browser through the flow.

---

## Defining Auth Profiles

Auth profiles are declared in your SpecGuard configuration under `config.auth.profiles[]`. Each profile requires the following fields:

| Field | Description |
|---|---|
| `name` | A unique identifier for this profile (e.g. `"admin"`, `"read-only-user"`). |
| `loginUrl` | The URL the browser should navigate to in order to begin the login flow. |
| `usernameEnvVar` | The **name** of the environment variable that holds the username. |
| `passwordEnvVar` | The **name** of the environment variable that holds the password. |

**Example:**

```yaml
auth:
  profiles:
    - name: admin
      loginUrl: https://app.example.com/login
      usernameEnvVar: ADMIN_USERNAME
      passwordEnvVar: ADMIN_PASSWORD
```

> **Important:** `usernameEnvVar` and `passwordEnvVar` are the *names* of environment variables, not the credential values themselves. Credentials are read exclusively from `process.env` at runtime and are never stored in or read from your config files directly.

---

## Credential Safety

Credentials are **always** sourced from environment variables — never from config values, LLM context, or log output. Before anything is written to a log, the `redact` function automatically replaces any occurrence of a credential value with `[REDACTED]`. This means your actual usernames and passwords will never appear in pipeline logs, even if something goes wrong during the login flow.

---

## Session Caching

Once a profile has been successfully authenticated, the session result is cached in memory by profile name. Any subsequent authentication request for the same profile name within the same run returns the cached result immediately, without repeating the browser login flow. This keeps your validate pipeline fast when multiple specs share the same auth profile.

To clear the session cache between test runs, call `clearSessionCache()`. This empties all cached sessions so the next run starts fresh.

---

## Authentication Results

Every authentication attempt returns an `AuthResult` object:

```ts
AuthResult {
  success: boolean;
  profile: string;
  error?: string;
}
```

The table below describes the possible outcomes:

| Scenario | `success` | `error` |
|---|---|---|
| Login completed successfully | `true` | *(none)* |
| Profile name not found in config | `false` | `"Profile not found"` |
| A required environment variable is missing | `false` | `"Missing credentials env var: <VAR>"` |
| Login navigation timed out or otherwise failed | `false` | `"Login failed: <reason>"` |

When `success` is `false`, the `error` field describes exactly what went wrong, making it straightforward to diagnose misconfigured profiles or missing environment variables in CI.

---

## Quick Reference

| Capability | Details |
|---|---|
| **Trigger** | Called by the validate pipeline via `authenticate(handle, profileName, config)` |
| **Credential source** | `process.env` only |
| **Log safety** | All credential values are redacted before logging |
| **Session reuse** | Cached in memory per profile name for the duration of the run |
| **Cache reset** | `clearSessionCache()` |
| **Return type** | `AuthResult { success, profile, error? }` |
