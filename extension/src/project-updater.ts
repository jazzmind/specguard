/**
 * Project file updater.
 *
 * On workspace activation, compares the version stamp in
 * `.specguard/sg-version.json` against the current extension version.
 * If the project is behind, offers to regenerate the managed harness files
 * (CLAUDE.md, skills, /goal command, AGENTS.md, MCP wiring) by invoking the
 * bundled CLI's `scaffold` command — the single, language-aware source of
 * truth for these files. Files lacking the `<!-- specguard-managed: true -->`
 * marker are treated as user-authored and never overwritten.
 *
 * The `specguard.updateProject` command bypasses the version check and
 * always runs a full sync.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SgVersionFile {
  /** Extension version that last wrote these files. */
  version: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
  /** Files managed by the updater (relative to workspace root). */
  managedFiles: string[];
}

const VERSION_FILE = path.join('.specguard', 'sg-version.json');

/** Harness files the scaffold manages, for the version stamp + notifications. */
const MANAGED_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  path.join('.claude', 'skills', 'specguard', 'SKILL.md'),
  path.join('.claude', 'commands', 'goal.md'),
  path.join('.cursor', 'skills', 'specguard', 'SKILL.md'),
  path.join('.cursor', 'commands', 'goal.md'),
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called on activation. Shows a notification if the project files are behind
 * the current extension version. Respects the user's "skip this version"
 * preference stored in global state.
 */
export async function checkAndOfferUpdate(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): Promise<void> {
  // Only run when the project already has a .specguard config.
  const configPath = path.join(workspaceRoot, '.specguard', 'config.json');
  if (!fs.existsSync(configPath)) return;

  const currentVersion = (context.extension.packageJSON as { version: string }).version;
  const storedVersion = readStoredVersion(workspaceRoot);

  if (storedVersion === currentVersion) return;

  // Check if the user said "skip this version" for the current extension version.
  const skipKey = `specguard.skipUpdateVersion.${currentVersion}`;
  const skipped = context.globalState.get<boolean>(skipKey, false);
  if (skipped) return;

  const fromLabel = storedVersion ? `v${storedVersion}` : 'not set up';
  const action = await vscode.window.showInformationMessage(
    `SpecGuard project files are outdated (${fromLabel} → v${currentVersion}). Regenerate CLAUDE.md, skills, and /goal command?`,
    'Update',
    'Skip',
    `Don't ask for v${currentVersion}`,
  );

  if (action === 'Update') {
    await syncProjectFiles(workspaceRoot, currentVersion);
    vscode.window.showInformationMessage(
      `SpecGuard: project files updated to v${currentVersion}.`,
      'Open AGENTS.md',
    ).then((btn) => {
      if (btn === 'Open AGENTS.md') {
        void vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(path.join(workspaceRoot, 'AGENTS.md')),
        );
      }
    });
  } else if (action === `Don't ask for v${currentVersion}`) {
    await context.globalState.update(skipKey, true);
  }
}

/**
 * Force-sync all managed files regardless of version. Called by the
 * `specguard.updateProject` command.
 */
export async function forceUpdateProjectFiles(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): Promise<void> {
  const configPath = path.join(workspaceRoot, '.specguard', 'config.json');
  if (!fs.existsSync(configPath)) {
    vscode.window.showErrorMessage(
      'SpecGuard: no .specguard/config.json found. Run "SpecGuard: Initialize" first.',
    );
    return;
  }

  const currentVersion = (context.extension.packageJSON as { version: string }).version;
  const result = await syncProjectFiles(workspaceRoot, currentVersion);

  const updatedList = result.updated.map((f) => `  • ${f}`).join('\n');
  const skippedList = result.skipped.map((f) => `  • ${f} (user-authored, skipped)`).join('\n');
  const summary = [
    result.updated.length > 0 ? `Updated:\n${updatedList}` : '',
    result.skipped.length > 0 ? `Skipped:\n${skippedList}` : '',
  ].filter(Boolean).join('\n\n');

  vscode.window.showInformationMessage(
    `SpecGuard: ${result.updated.length} file(s) updated, ${result.skipped.length} skipped.`,
    'Show Details',
  ).then((btn) => {
    if (btn === 'Show Details') {
      const channel = vscode.window.createOutputChannel('SpecGuard Update');
      channel.appendLine(summary || 'All files already up to date.');
      channel.show();
    }
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface SyncResult {
  updated: string[];
  skipped: string[];
}

/**
 * Regenerate the managed harness files by invoking the bundled CLI's
 * `scaffold` command. The CLI is the single source of truth — it generates
 * language-aware files (from `.specguard/config.json`'s `language`) for both
 * the Claude Code and Cursor harnesses, and never clobbers user content.
 */
async function syncProjectFiles(workspaceRoot: string, version: string): Promise<SyncResult> {
  const cliPath = await resolveCliPath(workspaceRoot);
  const lines: string[] = [];
  const handle = spawnCli(cliPath, ['scaffold', '--harness', 'both'], workspaceRoot, (l) => lines.push(l));
  await handle.promise;

  // Parse the CLI's `created`/`updated`/`skipped` log lines for the summary.
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(created|updated|skipped)\s+(\S+)/);
    if (!m) continue;
    if (m[1] === 'skipped') skipped.push(m[2]);
    else updated.push(m[2]);
  }

  writeVersionFile(workspaceRoot, version, MANAGED_FILES);
  return { updated, skipped };
}

function readStoredVersion(workspaceRoot: string): string | null {
  const versionPath = path.join(workspaceRoot, VERSION_FILE);
  if (!fs.existsSync(versionPath)) return null;
  try {
    const raw = fs.readFileSync(versionPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SgVersionFile>;
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function writeVersionFile(workspaceRoot: string, version: string, managedFiles: string[]): void {
  const versionPath = path.join(workspaceRoot, VERSION_FILE);
  const versionDir = path.dirname(versionPath);
  if (!fs.existsSync(versionDir)) {
    fs.mkdirSync(versionDir, { recursive: true });
  }
  const data: SgVersionFile = {
    version,
    updatedAt: new Date().toISOString(),
    managedFiles,
  };
  fs.writeFileSync(versionPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
