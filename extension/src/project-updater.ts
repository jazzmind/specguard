/**
 * Project file updater.
 *
 * On workspace activation, compares the version stamp in
 * `.specguard/sg-version.json` against the current extension version.
 * If the project is behind, offers to update the managed files:
 *
 *   - AGENTS.md
 *   - .cursor/skills/specguard/SKILL.md
 *
 * Files that do not contain the `<!-- specguard-managed: true -->` marker
 * are assumed to be user-authored and are never overwritten.
 *
 * The `specguard.updateProject` command bypasses the version check and
 * always runs a full sync.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AGENTS_MD, SKILL_MD } from './templates.js';

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

interface ManagedFile {
  /** Path relative to workspace root. */
  relPath: string;
  /** Canonical content to write. */
  content: string;
}

// ---------------------------------------------------------------------------
// Managed file definitions
// ---------------------------------------------------------------------------

/** Files the updater owns. Order determines display in notifications. */
function getManagedFiles(): ManagedFile[] {
  return [
    { relPath: 'AGENTS.md', content: AGENTS_MD },
    { relPath: path.join('.cursor', 'skills', 'specguard', 'SKILL.md'), content: SKILL_MD },
  ];
}

const MANAGED_MARKER = '<!-- specguard-managed: true -->';
const VERSION_FILE = path.join('.specguard', 'sg-version.json');

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
    `SpecGuard project files are outdated (${fromLabel} → v${currentVersion}). Update AGENTS.md and Cursor skill?`,
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

async function syncProjectFiles(workspaceRoot: string, version: string): Promise<SyncResult> {
  const managedFiles = getManagedFiles();
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const mf of managedFiles) {
    const absPath = path.join(workspaceRoot, mf.relPath);
    const dir = path.dirname(absPath);

    // If the file already exists but is NOT managed by us, skip it.
    if (fs.existsSync(absPath)) {
      const existing = fs.readFileSync(absPath, 'utf-8');
      if (!existing.includes(MANAGED_MARKER)) {
        skipped.push(mf.relPath);
        continue;
      }
    }

    // Ensure the parent directory exists.
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(absPath, mf.content, 'utf-8');
    updated.push(mf.relPath);
  }

  // Write/update the version stamp.
  writeVersionFile(workspaceRoot, version, managedFiles.map((f) => f.relPath));

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
