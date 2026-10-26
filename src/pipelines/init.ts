/**
 * Init pipeline.
 *
 * Scaffolds `.specguard/config.json` and `specs/README.md` in the target
 * directory when they are missing, and git-ignores generated run state. It asks
 * for no API key (inside a coding agent the agent does the model work; elsewhere
 * `specguard key set` stores one) and writes agent-harness files only when a
 * `harness` is named. Never overwrites existing files. Returns a `PipelineResult`
 * describing what was created and what was skipped.
 *
 * This is the pure-logic counterpart to `cli/commands/init.ts`, which wraps
 * this function with stdout messages and `process.exit`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { fileExists, readFile } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import {
  detectLanguage,
  getProfile,
  type LanguageId,
  type LanguageProfile,
} from '../core/language-profiles.js';
import { scaffoldCodexFiles, scaffoldHarnessFiles, type Harness } from '../core/scaffold.js';
import { applyIgnoreBlock, GENERATED_STATE_PATHS } from '../core/state-ignore.js';
import { detectMonorepo, testCommandFor, type Ecosystem, type MonorepoInfo, type WorkspacePackage } from '../core/monorepo.js';
import { unitsFromMonorepo } from '../core/workspace-units.js';
import { installCommandFor, renderPullRequestWorkflow, renderRemediateWorkflow, WORKFLOW_FILES } from '../core/ci-workflow.js';

export interface InitOpts {
  /** Test framework override; defaults to the language profile's framework. */
  framework?: string;
  /** Target language; auto-detected from the project when not set. */
  language?: LanguageId;
  /** Which agent harness files to generate (claude|cursor|both). Default: none; the plugins make them unnecessary. */
  harness?: Harness;
  /** Override the target directory (default: process.cwd()). */
  cwd?: string;
  /** Treat the repo as one app even when a pnpm/Yarn/npm/Nx/Turbo workspace is detected. */
  single?: boolean;
  /** How generated MCP/hook commands invoke SpecGuard: node|npx|path (default: local binary, else npx). */
  runner?: 'node' | 'npx' | 'path';
  runnerPath?: string;
  /** Apply differing existing MCP entries/hooks instead of printing a diff. */
  updateHooks?: boolean;
  /** Wire the requirement-history hooks into `.claude/settings.local.json`. */
  historyHooks?: boolean;
  /** Write the repository's Codex wiring: `.codex/hooks.json` (the edit guard) and `.codex/rules/specguard.rules` (forbids approving requirements from a shell). */
  codex?: boolean;
  /** Write CI workflows for this provider (`github`): a pull request gate with a comment, and scheduled remediation. */
  ci?: 'github';
  /** With `ci`: enable auto-merge of dependency fixes that keep every proof. */
  autoMerge?: boolean;
}

export interface InitResult extends PipelineResult {
  created: number;
  skipped: number;
  /** Paths that were newly created. */
  createdFiles: string[];
  /** Paths that already existed and were not overwritten. */
  skippedFiles: string[];
}

const PROFILE_OF: Record<Ecosystem, LanguageId> = { js: 'typescript', python: 'python', go: 'go', rust: 'rust' };

/**
 * One app per ecosystem, not per package: its sources list every package's
 * code. Capabilities cut across packages, so a package-shaped app would put the
 * per-file granularity problem back at package level. How to run each
 * package's tests lives in the units manifest.
 */
function monorepoApps(info: MonorepoInfo, primary: LanguageProfile): Array<Record<string, unknown>> {
  const byEcosystem = new Map<Ecosystem, WorkspacePackage[]>();
  for (const pkg of info.packages) byEcosystem.set(pkg.ecosystem, [...(byEcosystem.get(pkg.ecosystem) ?? []), pkg]);
  // The primary language's ecosystem first, so it gets the plain name `app`.
  const order = [...byEcosystem.keys()].sort((a, b) => Number(PROFILE_OF[b] === primary.id) - Number(PROFILE_OF[a] === primary.id));
  return order.map((eco, i) => {
    const profile = getProfile(PROFILE_OF[eco]);
    const pkgs = byEcosystem.get(eco) as WorkspacePackage[];
    // A negation stays at the front: `!**/*_test.go` becomes `!svc/**/*_test.go`, not `svc/!**/*_test.go`.
    const prefix = (globs: string[]): string[] =>
      pkgs.flatMap((p) => globs.map((g) => (g.startsWith('!') ? `!${p.dir}/${g.slice(1)}` : `${p.dir}/${g}`)));
    return {
      name: i === 0 ? 'app' : `app-${eco}`,
      repo: '.',
      language: profile.id,
      specDir: 'specs',
      sources: {
        routes: prefix(profile.sourceGlobs.routes),
        api: prefix(profile.sourceGlobs.api),
        tests: prefix(profile.sourceGlobs.tests),
      },
      framework: pkgs[0].framework,
      testOutput: profile.testOutput,
      security: { enabled: false },
      docs: false,
    };
  });
}

/** `.specguard/workspace.json` for a monorepo: its packages as units. */
function monorepoManifest(cwd: string, info: MonorepoInfo): string {
  return `${JSON.stringify({ version: '2', name: path.basename(cwd), repos: {}, units: unitsFromMonorepo(info, (pkg) => testCommandFor(info, pkg)) }, null, 2)}\n`;
}

/**
 * TypeScript/JavaScript profiles assume `src/`. A project that keeps its code at the repo root (or under another
 * folder) would match nothing and `spec draft` would find no source files, so without a `src/` folder every
 * code file counts except tests, type declarations and tool configs.
 */
const ROOT_JS_SOURCES: LanguageProfile['sourceGlobs'] = {
  routes: ['**/*.{ts,tsx,js,jsx,mjs,cjs}', '!**/*.{test,spec}.*', '!**/__tests__/**', '!tests/**', '!**/*.d.ts', '!**/*.config.*', '!**/build/**'],
  api: ['**/api/**/*.{ts,js}'],
  tests: ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}', 'tests/**/*.{ts,js}'],
};

function sourcesFor(profile: LanguageProfile, cwd: string): LanguageProfile['sourceGlobs'] {
  const rooted = profile.id === 'typescript' && !existsSync(path.join(cwd, 'src'));
  return rooted ? ROOT_JS_SOURCES : profile.sourceGlobs;
}

/** Build a config template from the resolved language profile. */
function defaultConfig(profile: LanguageProfile, framework: string, monorepo?: MonorepoInfo | null, sources: LanguageProfile['sourceGlobs'] = profile.sourceGlobs): string {
  const apps =
    monorepo && monorepo.packages.length > 0
      ? monorepoApps(monorepo, profile)
      : [
          {
            name: 'app',
            repo: '.',
            language: profile.id,
            specDir: 'specs',
            sources: { routes: sources.routes, api: sources.api, tests: sources.tests },
            framework,
            testOutput: profile.testOutput,
            security: { enabled: false },
            docs: false,
          },
        ];
  const config = {
    // Code-quality checks and the commit helper are plugins, on by default for new projects.
    plugins: ['quality', 'git'],
    apps,
    runners: {
      playwright: 'local',
      semgrep: 'auto',
      testRunner: 'local',
    },
    heal: {
      maxRetries: 2,
      testCommand: profile.testCommand,
    },
    matrix: {
      format: 'json',
      output: '.specguard/traceability.json',
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

const SPECS_README = `# Specs

These files are the source of truth for what the system is for. Code is fluid; specs, and the
tests that prove the code conforms to them, are what lasts.

- \`system.md\` — the problem, the users and the value, with a map of the capabilities.
- \`capabilities/<id>.md\` — one piece of functionality that delivers user or business value (about 10-15 per
  system). It lists the code, tests and docs behind it, and its requirements, one per bullet with a
  \`<!-- claim: id -->\` marker.
- \`history/\` — the prompts, approved plans and decisions that shaped the requirements.

## Working with them

\`\`\`bash
specguard spec draft --yes     # write the system and capability specs from existing code
specguard spec tag --yes       # link existing tests to requirements
specguard test run             # run the tests and record what each requirement is proven by
specguard check                # where specs, tests and code agree, and where they do not
\`\`\`

Tag a test with the requirement it proves: \`// [claims: capabilities/<id>#<claim-id>]\`.
Do not write one spec per file; several files that deliver one piece of functionality belong in one capability.
`;

/** Generated-state files that git already tracks (so ignoring them is not enough). */
function trackedGeneratedState(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '--', ...GENERATED_STATE_PATHS], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Scaffold the SpecGuard configuration and supporting files in `cwd`.
 * Never overwrites existing files.
 */
export async function runInit(opts: InitOpts = {}): Promise<InitResult> {
  const result = emptyResult('init') as InitResult;
  result.createdFiles = [];
  result.skippedFiles = [];

  const cwd = opts.cwd ?? process.cwd();
  const language = opts.language ?? (await detectLanguage(cwd));
  const profile = getProfile(language);
  const framework = opts.framework ?? profile.testFramework;

  const configPath = path.join(cwd, '.specguard', 'config.json');
  const specsReadmePath = path.join(cwd, 'specs', 'README.md');
  const gitignorePath = path.join(cwd, '.gitignore');

  const tryCreate = async (filePath: string, content: string): Promise<void> => {
    const rel = path.relative(cwd, filePath);
    if (await fileExists(filePath)) {
      result.messages.push(`  skipped  ${rel} (already exists)`);
      result.skippedFiles.push(filePath);
      result.skipped += 1;
    } else {
      await writeFile(filePath, content);
      result.messages.push(`  created  ${rel}`);
      result.createdFiles.push(filePath);
      result.created += 1;
    }
  };

  const monorepo = opts.single ? null : await detectMonorepo(cwd);
  if (monorepo && monorepo.packages.length > 0) {
    result.messages.push(
      `  detected ${monorepo.tools.join(' + ')} workspace: ${monorepo.packages.length} package(s) as units of one system`,
    );
    await tryCreate(path.join(cwd, '.specguard', 'workspace.json'), monorepoManifest(cwd, monorepo));
  }
  await tryCreate(configPath, defaultConfig(profile, framework, monorepo, sourcesFor(profile, cwd)));
  await tryCreate(specsReadmePath, SPECS_README);

  // Best-effort: keep generated run state (and the .env secrets file) out of version control.
  try {
    const before = (await fileExists(gitignorePath)) ? await readFile(gitignorePath) : '';
    const after = applyIgnoreBlock(before);
    if (after !== before) {
      await writeFile(gitignorePath, after);
      result.messages.push('  updated  .gitignore (generated SpecGuard state ignored)');
    }
    const tracked = trackedGeneratedState(cwd);
    if (tracked.length > 0) {
      result.messages.push(
        `  note     ${tracked.length} generated file(s) are already tracked by git; untrack with:`,
        `           git rm --cached ${tracked.join(' ')}`,
      );
    }
  } catch { /* best-effort */ }

  // Agent-harness files (CLAUDE.md, skills, MCP wiring, /goal command) only when asked for: the Claude Code and Codex
  // plugins bring the same skills and MCP server without writing into the project.
  if (opts.harness) {
    const scaffold = await scaffoldHarnessFiles({
      cwd,
      profile,
      harness: opts.harness,
      runner: opts.runner,
      runnerPath: opts.runnerPath,
      updateHooks: opts.updateHooks,
      historyHooks: opts.historyHooks,
    });
    result.createdFiles.push(...scaffold.created);
    result.skippedFiles.push(...scaffold.skipped);
    result.created += scaffold.created.length;
    result.updated += scaffold.updated.length;
    result.skipped += scaffold.skipped.length;
    result.messages.push(...scaffold.messages);
  } else if (opts.historyHooks) {
    result.messages.push('  note     --history-hooks needs --harness claude (the hooks go in .claude/settings.local.json)');
  }

  if (opts.codex) {
    const codex = await scaffoldCodexFiles({ cwd, runner: opts.runner, runnerPath: opts.runnerPath, updateHooks: opts.updateHooks });
    result.createdFiles.push(...codex.created);
    result.skippedFiles.push(...codex.skipped);
    result.created += codex.created.length;
    result.updated += codex.updated.length;
    result.skipped += codex.skipped.length;
    result.messages.push(...codex.messages);
  }

  if (opts.ci === 'github') {
    const has = (f: string): boolean => existsSync(path.join(cwd, f));
    const workflowOpts = { install: installCommandFor(has), affected: has('.specguard/workspace.json') && /"kind":\s*"package"/.test(readFileSync(path.join(cwd, '.specguard/workspace.json'), 'utf8')), verify: true };
    const files: Array<[string, string]> = [
      [WORKFLOW_FILES.pullRequest, renderPullRequestWorkflow(workflowOpts)],
      [WORKFLOW_FILES.remediate, renderRemediateWorkflow({ ...workflowOpts, autoMerge: opts.autoMerge })],
    ];
    for (const [rel, text] of files) {
      if (has(rel)) {
        result.skipped += 1;
        result.skippedFiles.push(rel);
        result.messages.push(`  exists   ${rel} (not overwritten)`);
        continue;
      }
      await writeFile(path.join(cwd, rel), text);
      result.created += 1;
      result.createdFiles.push(rel);
      result.messages.push(`  created  ${rel}`);
    }
  }

  result.messages.unshift(
    `specguard init (language: ${profile.id}, framework: ${framework}${opts.harness ? `, harness: ${opts.harness}` : ''}${opts.codex ? ', codex' : ''})`,
  );
  result.exitCode = ExitCode.Success;
  return result;
}
