/**
 * How the extension starts the SpecGuard CLI without a shell.
 *
 * `spawn(cmd, args, { shell: true })` joins the arguments into one command line, so a space, `&` or `;` in an argument
 * (a spec key, a file the user picked, a value a webview sent) becomes shell syntax. This plans the call instead:
 * a script runs under `node` (a `.ts` dev checkout under `node --import tsx`), anything else runs directly, and the
 * one case that needs `cmd.exe` (a Windows `.cmd` shim, which Node refuses to run without it) gets every argument
 * double-quoted after refusing the characters that cannot be quoted safely.
 */
import * as fs from 'fs';

export class UnsafeArgumentError extends Error {
  constructor(readonly arg: string) {
    super(`refusing to pass an argument containing a quote, percent sign, newline or NUL to cmd.exe: ${JSON.stringify(arg.slice(0, 60))}`);
    this.name = 'UnsafeArgumentError';
  }
}

export interface SpawnPlan {
  command: string;
  args: string[];
  /** Set for the `cmd.exe` case, where Node must not re-quote the command line it was given. */
  windowsVerbatimArguments?: boolean;
}

export interface PlanOptions {
  platform?: NodeJS.Platform;
  /** The executable that runs `.js` and `.ts` entry points. Default `node`. */
  node?: string;
  exists?: (file: string) => boolean;
  comspec?: string;
}

/** One argument for `cmd.exe`: double-quoted, so `&`, `|`, `(`, `<` and spaces are literal. */
export function winQuote(arg: string): string {
  if (/["%\r\n\0]/.test(arg)) throw new UnsafeArgumentError(arg);
  // A trailing backslash would escape the closing quote.
  return `"${arg.endsWith('\\') ? `${arg}\\` : arg}"`;
}

export function planSpawn(cliPath: string, args: string[], o: PlanOptions = {}): SpawnPlan {
  const platform = o.platform ?? process.platform;
  const node = o.node ?? 'node';
  const exists = o.exists ?? fs.existsSync;
  if (cliPath.endsWith('.js')) return { command: node, args: [cliPath, ...args] };
  if (cliPath.endsWith('.ts')) return { command: node, args: ['--import', 'tsx', cliPath, ...args] };
  if (platform !== 'win32') return { command: cliPath, args };

  // Windows: a bare name or a `.cmd`/`.bat` shim needs cmd.exe; an `.exe` does not.
  let target = cliPath;
  if (!/\.[A-Za-z0-9]+$/.test(target) && exists(`${target}.cmd`)) target = `${target}.cmd`;
  if (/\.(exe|com)$/i.test(target)) return { command: target, args };
  return {
    command: o.comspec ?? process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[target, ...args].map(winQuote).join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * One argument for a shell a terminal will run: single-quoted, so `$(...)`, backticks, `;` and `&` in a file name are
 * text. POSIX shells close the quote, add `\'` and reopen it; PowerShell doubles the quote. (The terminal's own shell
 * is not known to the extension; cmd.exe is not covered, and a NUL or newline is refused outright.)
 */
export function shellQuote(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (/[\0\r\n]/.test(arg)) throw new UnsafeArgumentError(arg);
  return platform === 'win32' ? `'${arg.replace(/'/g, "''")}'` : `'${arg.replace(/'/g, "'\\''")}'`;
}
