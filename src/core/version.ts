/**
 * The one place the CLI version comes from.
 *
 * `package.json` is the source of truth. Bundles (the VS Code extension's
 * `dist/cli.js`) have no `package.json` beside them, so the build injects the
 * version with `--define:__SPECGUARD_VERSION__="<version>"`. Unbundled runs read
 * `package.json` directly.
 *
 * Spec: specs/core/version.md
 */
import { createRequire } from 'node:module';

declare const __SPECGUARD_VERSION__: string | undefined;

export const PACKAGE_NAME = 'specguard-ai';

let cached: string | undefined;

export function cliVersion(): string {
  if (cached) return cached;
  if (typeof __SPECGUARD_VERSION__ === 'string' && __SPECGUARD_VERSION__) {
    cached = __SPECGUARD_VERSION__;
    return cached;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    if (pkg.version) {
      cached = pkg.version;
      return cached;
    }
  } catch {
    /* no package.json next to this file */
  }
  cached = 'unknown';
  return cached;
}

/** The payload of `specguard --version --json`. */
export function versionInfo(): { name: string; version: string; node: string } {
  return { name: PACKAGE_NAME, version: cliVersion(), node: process.version };
}
