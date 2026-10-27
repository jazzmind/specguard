/**
 * Project file updater.
 *
 * On workspace activation, compares the version stamp in
 * `.specguard/sg-version.json` against the current extension version.
 * If the project is behind, offers to regenerate the managed harness files
 * (CLAUDE.md, skills, /goal command, AGENTS.md, MCP wiring) by invoking the
 * bundled CLI's `scaffold` command — the single, language-aware source of
 * truth for these files. Files lacking the `<!-- specguard-managed: true -->`
 * marker are skipped, except CLAUDE.md whose SpecGuard sections are merged.
 *
 * The `specguard.updateProject` command bypasses the version check and
 * offers a preview before a full sync.
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
  // Only run when the project already has its own .specguard config. A repo whose specs live in an overlay is left
  // alone on purpose: these managed files would be written into the application repo, which an overlay keeps clean.
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
    `SpecGuard setup ${fromLabel} → v${currentVersion}. Review the update: your CLAUDE.md rules outside SpecGuard sections are preserved; marked skills and AGENTS.md are replaced.`,
    'Review update',
    'Skip',
    `Don't ask for v${currentVersion}`,
  );

  if (action === 'Review update') {
    if (!(await confirmUpdate(workspaceRoot))) return;
    try {
      const result = await syncProjectFiles(workspaceRoot, currentVersion);
      void vscode.window.showInformationMessage(`SpecGuard: setup updated to v${currentVersion} (${result.updated.length} changed, ${result.skipped.length} skipped).`);
    } catch (error) {
      void vscode.window.showErrorMessage(`SpecGuard setup update failed: ${(error as Error).message}`);
    }
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
  if (!(await confirmUpdate(workspaceRoot))) return;
  let result: SyncResult;
  try { result = await syncProjectFiles(workspaceRoot, currentVersion); }
  catch (error) {
    void vscode.window.showErrorMessage(`SpecGuard setup update failed: ${(error as Error).message}`);
    return;
  }

  const updatedList = result.updated.map((f) => `  • ${f}`).join('\n');
  const skippedList = result.skipped.map((f) => `  • ${f} (left unchanged)`).join('\n');
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

/** Explain exactly which content the CLI preserves, replaces or skips. */
export function updatePreview(workspaceRoot: string): string[] {
  const lines = ['CLAUDE.md: update only SpecGuard sections; preserve your surrounding Claude rules.'];
  for (const rel of MANAGED_FILES.filter((f) => f !== 'CLAUDE.md')) {
    const file = path.join(workspaceRoot, rel);
    if (!fs.existsSync(file)) { lines.push(`${rel}: create missing file.`); continue; }
    try {
      const marked = fs.readFileSync(file, 'utf8').includes('<!-- specguard-managed: true -->');
      lines.push(marked ? `${rel}: REPLACE the entire SpecGuard-managed file; custom edits inside it will be overwritten.` : `${rel}: preserve unchanged (user-authored; no managed marker).`);
    } catch { lines.push(`${rel}: could not read; inspect before updating.`); }
  }
  lines.push('JSON settings/MCP: merge SpecGuard entries, preserve unrelated rules and servers; malformed files and conflicting existing wiring are left unchanged.');
  return lines;
}

async function confirmUpdate(root: string): Promise<boolean> {
  const picked = await vscode.window.showInformationMessage('Update SpecGuard-managed setup files?', {
    modal: true,
    detail: updatePreview(root).join('\n\n'),
  }, 'Update SpecGuard files');
  return picked === 'Update SpecGuard files';
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
 * language-aware files for both harnesses. CLAUDE.md sections are merged; marked
 * standalone files are replaced, as explained in the update preview.
 */
async function syncProjectFiles(workspaceRoot: string, version: string): Promise<SyncResult> {
  const cliPath = await resolveCliPath(workspaceRoot);
  const lines: string[] = [];
  const handle = spawnCli(cliPath, ['scaffold', '--harness', 'both'], workspaceRoot, (l) => lines.push(l));
  const exitCode = await handle.promise;
  if (exitCode !== 0) throw new Error(`scaffold exited ${exitCode ?? 'without a status'}. The setup version was not advanced. ${lines.slice(-4).join(' ')}`);

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
