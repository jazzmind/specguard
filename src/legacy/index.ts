/**
 * The one door to per-file (v1) specs for code that has to read or move them. `migrate` imports from here, never from
 * the v1 modules directly, so the plugin phase can point these exports at a separate `legacy` package without touching
 * `migrate`. Re-exports only: nothing is moved or wrapped, and the v1 commands (`reverse`, `generate`, `heal`,
 * `matrix`, `status`) stay where they are for this release.
 *
 * Spec: specs/capabilities/platform-foundation.md
 */
export { loadAllSpecs, parseSpecContent } from '../core/spec-parser.js';
