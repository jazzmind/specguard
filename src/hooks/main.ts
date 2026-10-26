/**
 * Entry point of the committed hook bundle (`plugins/specguard/hooks/dist/specguard-hook.mjs`). The logic is in
 * `entry.ts`; this file only runs it.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { main } from './entry.js';

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // The hook never fails an agent's session.
    process.exitCode = 0;
  },
);
