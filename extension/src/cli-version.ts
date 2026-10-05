/**
 * CLI / extension version check.
 *
 * The extension is built against one CLI version (`__EXPECTED_CLI_VERSION__`,
 * injected from the repo-root package.json). If the CLI it resolves (a local or
 * global install, or a path from `specguard.cliPath`) reports another version
 * through `specguard --version --json`, warn once per session.
 *
 * Spec: specs/core/version.md
 */
import { spawn } from 'child_process';

declare const __EXPECTED_CLI_VERSION__: string | undefined;

export interface CliVersionInfo {
  name: string;
  version: string;
}

/** The CLI version this extension was built with, or undefined in an unbundled dev run. */
export function expectedCliVersion(): string | undefined {
  return typeof __EXPECTED_CLI_VERSION__ === 'string' ? __EXPECTED_CLI_VERSION__ : undefined;
}

/** Parse the one-line JSON `specguard --version --json` prints. Returns null for anything else. */
export function parseVersionOutput(output: string): CliVersionInfo | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const doc = JSON.parse(trimmed) as Partial<CliVersionInfo>;
      if (typeof doc.version === 'string') return { name: String(doc.name ?? ''), version: doc.version };
    } catch {
      /* not JSON: keep looking */
    }
  }
  return null;
}

/** Run `<cliPath> --version --json`. Resolves null when the CLI cannot be run or answers nonsense. */
export function queryCliVersion(cliPath: string, cwd: string, timeoutMs = 10_000): Promise<CliVersionInfo | null> {
  return new Promise((resolve) => {
    const isScript = cliPath.endsWith('.js');
    const isTs = cliPath.endsWith('.ts');
    const [cmd, args, shell] = isScript
      ? (['node', [cliPath, '--version', '--json'], false] as const)
      : isTs
        ? (['npx', ['tsx', cliPath, '--version', '--json'], true] as const)
        : ([cliPath, ['--version', '--json'], true] as const);
    let out = '';
    let settled = false;
    const done = (value: CliVersionInfo | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = spawn(cmd, [...args], { cwd, shell });
      const timer = setTimeout(() => {
        child.kill();
        done(null);
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', () => done(null));
      child.on('close', () => {
        clearTimeout(timer);
        done(parseVersionOutput(out));
      });
    } catch {
      done(null);
    }
  });
}

/** The warning text, or null when the versions agree or cannot be compared. */
export function mismatchMessage(found: CliVersionInfo | null, expected: string | undefined): string | null {
  if (!found || !expected || found.version === expected) return null;
  return (
    `SpecGuard CLI ${found.version} does not match the version this extension was built for (${expected}). ` +
    `Update with \`npm install -g specguard-ai@${expected}\`, or clear "specguard.cliPath" to use the bundled CLI.`
  );
}
