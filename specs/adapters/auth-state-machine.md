# Auth State Machine

<!-- module: src/adapters/auth-state-machine.ts -->
<!-- type: adapter -->
<!-- status: stable -->

## Overview

The auth state machine handles deterministic browser-based authentication for the
validate pipeline. Credentials are loaded from environment variables (never from LLM
context or logs). Authentication state is cached per profile so the validate pipeline
logs in once per named auth profile and reuses the session across all specs.

States: `NavigateToLogin → FillCredentials → WaitForResult → Success | 2FA | Failed`

## Acceptance Criteria

- `authenticate(handle, profileName, config)` executes the login state machine for the named profile.
- Auth profiles are defined in `config.auth.profiles[]` with `name`, `loginUrl`, `usernameEnvVar`, `passwordEnvVar`.
- Credentials are read exclusively from `process.env` — never from config values directly.
- `redact(text, profile)` replaces all occurrences of credential values with `[REDACTED]` before any logging.
- Session results are cached in memory by profile name; `authenticate` returns the cached result on subsequent calls with the same profile name.
- Returns `AuthResult { success: boolean, profile: string, error?: string }`.
- When the profile is not found in config, returns `AuthResult { success: false, error: 'Profile not found' }`.
- When env vars are missing, returns `AuthResult { success: false, error: 'Missing credentials env var: <VAR>' }`.
- When login navigation times out or fails, returns `AuthResult { success: false, error: 'Login failed: <reason>' }`.
- `clearSessionCache()` empties the in-memory session cache (used between test runs).

## Scenarios

### Scenario 1: Successful login
**Steps:**
1. Config has profile `admin` with `loginUrl`, `usernameEnvVar: 'ADMIN_USER'`, `passwordEnvVar: 'ADMIN_PASS'`
2. `ADMIN_USER` and `ADMIN_PASS` are set in env
3. Page navigates to loginUrl, fills credentials, succeeds

**Expected Results:**
- Returns `AuthResult { success: true, profile: 'admin' }`
- Result is cached for subsequent calls

### Scenario 2: Missing env var
**Steps:**
1. Profile `admin` references `ADMIN_PASS` which is not set

**Expected Results:**
- Returns `AuthResult { success: false, error: 'Missing credentials env var: ADMIN_PASS' }`

### Scenario 3: Profile not found
**Steps:**
1. Call `authenticate(handle, 'nonexistent', config)`

**Expected Results:**
- Returns `AuthResult { success: false, error: 'Profile not found: nonexistent' }`

### Scenario 4: redact strips credential values
**Steps:**
1. `redact('Error: invalid password secretABC', profile)` where password is 'secretABC'

**Expected Results:**
- Returns `'Error: invalid password [REDACTED]'`

## Security Notes

- Credential values must NEVER appear in log output, error messages, or LLM prompts.
- Always call `redact()` on any string before logging that may have been derived from an auth flow.
- The session cache holds no credential data — only success/failure state per profile.

## Dependencies

- `src/adapters/playwright.ts`
- `src/core/types.ts` (SpecGuardConfig)
