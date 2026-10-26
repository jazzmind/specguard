/**
 * `specguard hook pre-tool-use|build-index|doctor|log`: the agent edit guard's commands. `pre-tool-use` is the same code
 * the plugin's bundle runs (reading the host's JSON on stdin); the others build and inspect its ownership index.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: the registration function's signature is frozen; the commands are thin wiring over src/hooks/.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';

import { decideForEvent, findProject, HOOK_LOG_FILE, main as hookMain, type HookProject } from '../../hooks/entry.js';
import type { HookEvent, HookLogEntry } from '../../hooks/decide.js';
import { loadHookIndex } from '../../hooks/index-build.js';
import type { GlobalOpts } from './helpers.js';

const globalsOf = (cmd: Command): GlobalOpts => {
  const g = cmd.optsWithGlobals() as GlobalOpts;
  return { config: g.config, json: g.json };
};

/** The project for a command: `--config` (a file or directory) when given, else the current directory. In overlay mode `root` is the real repository and `stateRoot` the overlay app's folder. */
function projectFor(globals: GlobalOpts): HookProject | null {
  const start = globals.config ? path.resolve(globals.config.endsWith('.json') ? path.dirname(path.dirname(globals.config)) : globals.config) : process.cwd();
  return findProject(start);
}

const indexOpts = (p: HookProject): { repoRoot?: string } => (p.overlay?.repo ? { repoRoot: p.overlay.repo } : {});

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

export function registerHookCommands(program: Command): void {
  const hook = program.command('hook').description("the agent edit guard: runs before an agent's edit or shell command (see the plugin's hooks)");

  hook
    .command('pre-tool-use')
    .description("judge one tool call: the host's JSON on stdin, its decision as JSON on stdout. Fails open; silent outside a SpecGuard project")
    .option('--agent <host>', 'claude or codex (default: inferred from the payload)')
    .action(async (opts: { agent?: string }) => {
      const argv = ['pre-tool-use', ...(opts.agent ? ['--agent', opts.agent] : [])];
      process.exitCode = await hookMain(argv);
    });

  hook
    .command('build-index')
    .alias('index')
    .description('rebuild the ownership index the guard reads (.specguard/cache/hook-index.json)')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const globals = globalsOf(cmd);
      const project = projectFor(globals);
      if (!project) {
        process.stderr.write('No config found. Run `specguard init` to create one (or `specguard overlay add <dir>` when the specs live in another repo).\n');
        process.exitCode = 1;
        return;
      }
      const started = Date.now();
      const { index, cached } = await loadHookIndex(project.stateRoot, { force: true, ...indexOpts(project) });
      const summary = {
        root: project.root,
        ...(project.overlay ? { stateRoot: project.stateRoot } : {}),
        file: '.specguard/cache/hook-index.json',
        cached,
        ms: Date.now() - started,
        capabilities: index.capabilities.length,
        ownedFiles: Object.keys(index.owned).length,
        openChanges: index.openChanges.length,
        notes: index.notes ?? [],
      };
      if (globals.json) out(JSON.stringify(summary));
      else {
        out(`hook index: ${summary.capabilities} capabilities, ${summary.ownedFiles} owned files, ${summary.openChanges} open change(s) (${summary.ms} ms${cached ? '' : ', not cached: cache directory not writable'})`);
        for (const n of summary.notes) out(`  note: ${n}`);
      }
    });

  hook
    .command('doctor')
    .description('print what the guard would decide for a path (or a shell command), and why')
    .argument('[paths...]', 'repo-relative paths an edit would write')
    .option('--tool <name>', 'the tool making the edit', 'Edit')
    .option('--bash <command>', 'judge this shell command instead of a path')
    .option('--agent <host>', 'claude or codex', 'claude')
    .action(async (paths: string[], opts: { tool: string; bash?: string; agent: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      const project = projectFor(globals);
      if (!project) {
        process.stderr.write('No config found. Run `specguard init` to create one (or `specguard overlay add <dir>` when the specs live in another repo).\n');
        process.exitCode = 1;
        return;
      }
      const root = project.root;
      const { index, rebuilt } = await loadHookIndex(project.stateRoot, indexOpts(project));
      const rel = paths.map((p) => path.relative(root, path.resolve(root, p)).split(path.sep).join('/'));
      const event: HookEvent = {
        event: 'PreToolUse',
        tool: opts.bash !== undefined ? 'Bash' : opts.tool,
        paths: opts.bash !== undefined ? [] : rel,
        ...(opts.bash !== undefined ? { bash: opts.bash } : {}),
        agent: opts.agent === 'codex' ? 'codex' : 'claude',
      };
      const { classes, decision } = decideForEvent(event, root, index, project.stateRoot);
      if (globals.json) {
        out(JSON.stringify({ index: { rebuilt, fingerprint: index.fingerprint }, event, classes, decision }));
        return;
      }
      out(`index: ${rebuilt ? 'rebuilt just now' : 'from cache'} (${index.capabilities.length} capabilities, ${index.openChanges.length} open change(s))`);
      event.paths.forEach((p, i) => {
        const c = classes[i]!;
        out(`  ${p}: ${c.kind}${'capabilities' in c ? ` (${c.capabilities.join(', ')})` : ''}${'lockedBy' in c && c.lockedBy.length > 0 ? ` locked by ${c.lockedBy.join(', ')}` : ''}`);
      });
      out(`decision: ${decision.decision} [${decision.log.code}]${decision.log.level ? ` level ${decision.log.level}` : ''}${decision.log.change ? ` change ${decision.log.change}` : ''}`);
      if (decision.message) out(`message: ${decision.message}`);
    });

  hook
    .command('log')
    .description("the guard's recent decisions (.specguard/cache/hooks.jsonl), newest last")
    .option('--denied', 'only denials')
    .option('--limit <n>', 'how many lines', '20')
    .action(async (opts: { denied?: boolean; limit: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      const project = projectFor(globals);
      const file = project ? path.join(project.stateRoot, HOOK_LOG_FILE) : '';
      if (!project || !existsSync(file)) {
        out('no hook decisions logged yet');
        return;
      }
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const entries: HookLogEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as HookLogEntry);
        } catch {
          /* a torn line from a crashed writer */
        }
      }
      const shown = entries.filter((e) => !opts.denied || e.decision === 'deny').slice(-Math.max(1, Number.parseInt(opts.limit, 10) || 20));
      if (globals.json) {
        out(JSON.stringify(shown));
        return;
      }
      for (const e of shown) out(`${e.ts} ${e.decision.padEnd(5)} ${e.code} ${e.tool} ${e.paths.join(',')}${e.change ? ` (${e.change})` : ''}`);
    });
}
