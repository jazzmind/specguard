# Drift Registry — Load/Save/Update Helpers

<!-- module: specguard-core/drift-registry / type: core-utility / status: draft -->

## Overview

The Drift Registry is a persistent JSON store located at `.specguard/drift-registry.json` within a given root directory. It tracks, for each spec, the set of key source files that can affect it, recording a SHA-256 content hash, an ISO 8601 timestamp of the last check, and a verdict (`no-drift`, `drifted`, or `new-file`) per file. When a file's hash changes between checks, an LLM semantic drift check is triggered; if the hash is unchanged, the check is skipped. The module exposes helpers for resolving the registry path, loading and saving the registry to disk, hashing files and strings, and mutating spec and file entries within the registry.

## Acceptance Criteria

- AC-1: `registryPath(rootDir)` returns the path `<rootDir>/.specguard/drift-registry.json`.
- AC-2: `loadRegistry(rootDir)` returns an empty object `{}` when the registry file does not exist.
- AC-3: `loadRegistry(rootDir)` returns an empty object `{}` when the registry file contains invalid JSON.
- AC-4: `loadRegistry(rootDir)` returns the parsed `DriftRegistry` object when the file exists and contains valid JSON.
- AC-5: `saveRegistry(rootDir, registry)` creates the `.specguard/` directory (and any missing parents) if it does not exist, then writes the registry as pretty-printed JSON (2-space indent).
- AC-6: `hashFile(absPath)` returns a lowercase hex SHA-256 digest of the file's raw byte content.
- AC-7: `hashFile(absPath)` returns `null` when the file cannot be read.
- AC-8: `hashString(s)` returns a lowercase hex SHA-256 digest of the given string.
- AC-9: `getOrCreateSpecEntry` creates a new `DriftSpecEntry` with an empty `files` map when the spec key is not present in the registry.
- AC-10: `getOrCreateSpecEntry` updates `specHash` on an existing entry without clearing its `files` map.
- AC-11: `updateFileEntry` writes a `DriftFileEntry` keyed by `absPath` containing the provided hash, an ISO 8601 `lastChecked` timestamp, and the provided verdict.
- AC-12: `lastVerdict` values are restricted to `'no-drift'`, `'drifted'`, or `'new-file'`.

## Scenarios

### Scenario 1: Registry file does not exist

**Steps:**
1. Call `loadRegistry('/tmp/empty-project')` where no `.specguard/drift-registry.json` file exists at that path.

**Expected Results:**
- The return value strictly equals `{}`.
- No exception is thrown.

---

### Scenario 2: Registry file contains malformed JSON

**Steps:**
1. Create the file `/tmp/bad-project/.specguard/drift-registry.json` with content `{ invalid json`.
2. Call `loadRegistry('/tmp/bad-project')`.

**Expected Results:**
- The return value strictly equals `{}`.
- No exception is thrown.

---

### Scenario 3: Registry file contains valid JSON

**Steps:**
1. Write a valid `DriftRegistry` JSON object to `/tmp/valid-project/.specguard/drift-registry.json`.
2. Call `loadRegistry('/tmp/valid-project')`.

**Expected Results:**
- The return value is a JavaScript object matching the written JSON structure.
- All `specKey`, `specHash`, and `files` fields are present and correctly typed.

---

### Scenario 4: Save registry creates missing directories

**Steps:**
1. Ensure `/tmp/new-project/.specguard/` does not exist.
2. Call `saveRegistry('/tmp/new-project', { 'my-spec': { specKey: 'my-spec', specHash: 'abc123', files: {} } })`.
3. Read the file at `/tmp/new-project/.specguard/drift-registry.json`.

**Expected Results:**
- The `.specguard/` directory is created.
- The file exists and its content is valid JSON with 2-space indentation.
- The parsed content matches the registry object passed to `saveRegistry`.

---

### Scenario 5: Hash a readable file

**Steps:**
1. Write the bytes `hello world` to `/tmp/test-file.txt`.
2. Call `hashFile('/tmp/test-file.txt')`.

**Expected Results:**
- The return value is a 64-character lowercase hexadecimal string.
- The value equals the SHA-256 hex digest of `hello world`.

---

### Scenario 6: Hash an unreadable or missing file

**Steps:**
1. Call `hashFile('/tmp/nonexistent-file-xyz.txt')` where the file does not exist.

**Expected Results:**
- The return value is `null`.
- No exception is thrown.

---

### Scenario 7: Hash a string

**Steps:**
1. Call `hashString('specguard-test-input')`.

**Expected Results:**
- The return value is a 64-character lowercase hexadecimal string.
- The value equals the SHA-256 hex digest of the UTF-8 encoding of `'specguard-test-input'`.

---

### Scenario 8: Create a new spec entry

**Steps:**
1. Initialise an empty registry `{}`.
2. Call `getOrCreateSpecEntry(registry, 'my-spec', 'hash-v1')`.

**Expected Results:**
- The registry now contains a key `'my-spec'`.
- The entry has `specKey === 'my-spec'`, `specHash === 'hash-v1'`, and `files` is an empty object `{}`.
- The returned object is the same reference stored in `registry['my-spec']`.

---

### Scenario 9: Update specHash on an existing spec entry without clearing files

**Steps:**
1. Initialise a registry with an existing entry for `'my-spec'` that has one file entry under `files`.
2. Call `getOrCreateSpecEntry(registry, 'my-spec', 'hash-v2')`.

**Expected Results:**
- `registry['my-spec'].specHash` equals `'hash-v2'`.
- The existing `files` entries are unchanged.
- No new top-level key is added to the registry.

---

### Scenario 10: Update a file entry

**Steps:**
1. Create a `DriftSpecEntry` with an empty `files` map.
2. Call `updateFileEntry(specEntry, '/src/foo.ts', 'deadbeef01', 'drifted')`.

**Expected Results:**
- `specEntry.files['/src/foo.ts']` exists.
- `specEntry.files['/src/foo.ts'].hash` equals `'deadbeef01'`.
- `specEntry.files['/src/foo.ts'].lastVerdict` equals `'drifted'`.
- `specEntry.files['/src/foo.ts'].lastChecked` is a valid ISO 8601 timestamp string representing a time within 5 seconds of the call.

---

### Scenario 11: Overwrite an existing file entry

**Steps:**
1. Create a `DriftSpecEntry` with a pre-existing entry for `/src/foo.ts` with verdict `'no-drift'` and hash `'oldhash'`.
2. Call `updateFileEntry(specEntry, '/src/foo.ts', 'newhash', 'new-file')`.

**Expected Results:**
- `specEntry.files['/src/foo.ts'].hash` equals `'newhash'`.
- `specEntry.files['/src/foo.ts'].lastVerdict` equals `'new-file'`.
- `specEntry.files['/src/foo.ts'].lastChecked` is updated to a current ISO 8601 timestamp.
- No duplicate keys exist under `files`.

## Security Notes

- SHA-256 hashes are used solely for change-detection (drift triggering), not for cryptographic authentication or integrity guarantees against adversarial tampering.
- The registry file path is derived from a caller-supplied `rootDir`; callers must validate or sanitise `rootDir` to prevent path traversal to unintended filesystem locations.
- No credentials, API keys, or tokens are stored in the registry; only file content hashes, timestamps, and verdict strings.

## Dependencies

- **Node.js built-ins:** `node:fs` (file I/O), `node:path` (path resolution), `node:crypto` (SHA-256 hashing).
- **Runtime:** Node.js with ESM or CommonJS module support; no third-party runtime dependencies.
- **Consumers:** The drift-check orchestration layer is expected to call `loadRegistry`, mutate entries via `getOrCreateSpecEntry` and `updateFileEntry`, and persist changes via `saveRegistry` after each check cycle.