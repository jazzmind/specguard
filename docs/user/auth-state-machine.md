---
title: "Auth State Machine"
sidebar_label: "Auth State Machine"
generated: true
---

# Auth State Machine

## Overview

The Auth State Machine handles browser-based authentication for the validate pipeline. It drives a real browser through your login flow in a predictable, step-by-step sequence, keeping your credentials safe and your test runs efficient.

When the pipeline needs to authenticate, it follows these stages in order:

**Navigate to Login → Fill Credentials → Wait for Result → Success, 2FA, or Failed**

Sessions are cached per auth profile, so the pipeline logs in once and reuses that session across all specs that share the same profile — no redundant logins mid-run.

---

## Defining Auth Profiles

Auth profiles are configured under `config.auth.profiles[]`. Each profile describes a named login context:

| Field | Description |
|---|---|
| `name` | A unique identifier for this profile (e.g. `"admin"`, `"read-only-user"`). |
| `loginUrl` | The URL the browser navigates to in order to start the login flow. |
| `usernameEnvVar` | The name of the environment variable that holds the username. |
| `passwordEnvVar` | The name of the environment variable that holds the password. |

**Example configuration:**

```json
{
  "auth": {
    "profiles": [
      {
        "name": "admin",
        "loginUrl": "https://example.com/login",
        "usernameEnvVar": "ADMIN_USERNAME",
        "passwordEnvVar": "ADMIN_PASSWORD"
      }
    ]
  }
}
```

Credentials are read exclusively from environment variables at runtime — they are never read from config file values directly, and they are never sourced from LLM context or logs.

---

## Credential Safety and Redaction

Before anything is written to logs, the `redact` function replaces all occurrences of actual credential values with `[REDACTED]`. This means your username and password will never appear in pipeline output, even if something goes wrong mid-authentication.

---

## Session Caching

Once a profile authenticates successfully, the result is cached in memory for the duration of the run. Any subsequent call to authenticate using the same profile name returns the cached result immediately, skipping the browser login flow entirely.

To reset this cache between test runs, call `clearSessionCache()`. This empties all stored sessions so the next run starts fresh.

---

## Authentication Results

Every authentication attempt returns an `AuthResult` object:

```ts
AuthResult {
  success: boolean
  profile: string
  error?: string
}
```

The table below describes what to expect in common situations:

| Situation | `success` | `error` |
|---|---|---|
| Login completed successfully | `true` | *(none)* |
| Profile name not found in config | `false` | `"Profile not found"` |
| A required environment variable is not set | `false` | `"Missing credentials env var: <VAR>"` |
| Login navigation timed out or otherwise failed | `false` | `"Login failed: <reason>"` |

When `success` is `false`, the `error` field describes what went wrong so you can diagnose configuration or environment issues quickly.
