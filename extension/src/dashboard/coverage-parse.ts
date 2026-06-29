import * as fs from 'fs';
import * as path from 'path';
import type { AppCoverage, CoverageItem } from './protocol.js';

/** Lenient parser for the text output of `specguard status` (no --json yet). */
export function parseCoverageText(raw: string): AppCoverage[] {
  const apps: AppCoverage[] = [];
  const appSections = raw.split(/^# /m).filter(Boolean);

  for (const section of appSections) {
    const lines = section.split('\n');
    const header = lines[0] ?? '';
    const nameMatch = header.match(/^(\S+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const items: CoverageItem[] = [];
    for (const line of lines.slice(1)) {
      const noTestMatch = line.match(/^\s+\[ok\]\s+(\S+)\s+\(no test\)/);
      const okMatch = line.match(/^\s+\[ok\]\s+(\S+)/);
      const missingMatch = line.match(/^\s+\[missing-spec\]\s+(\S+)/);
      if (noTestMatch) items.push({ app: name, key: noTestMatch[1], hasSpec: true, hasTest: false });
      else if (okMatch) items.push({ app: name, key: okMatch[1], hasSpec: true, hasTest: true });
      else if (missingMatch) items.push({ app: name, key: missingMatch[1], hasSpec: false, hasTest: false });
    }

    const summary = section.match(/(\d+) source files, (\d+) specs \((\d+)%\), (\d+) tests/);
    const sourceCount = summary ? parseInt(summary[1], 10) : items.length;
    const specCount = summary ? parseInt(summary[2], 10) : items.filter((i) => i.hasSpec).length;
    const percentage = summary ? parseInt(summary[3], 10) : 0;
    apps.push({ name, specCount, sourceCount, testCount: 0, percentage, items });
  }
  return apps;
}

/**
 * For apps where `status` reports 0 source files (e.g. specs created via
 * `import` from a PRD, with no matching source code), augment the coverage
 * data by directly counting `.md` files in each app's specDir so the
 * dashboard and sidebar reflect reality rather than showing 0 specs.
 *
 * Reads `.specguard/config.json` from `workspaceRoot` to discover specDirs.
 */
export function augmentCoverageFromDisk(coverage: AppCoverage[], workspaceRoot: string): void {
  try {
    const configFile = path.join(workspaceRoot, '.specguard', 'config.json');
    if (!fs.existsSync(configFile)) return;
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as {
      apps?: Array<{ name: string; specDir: string }>;
    };
    if (!Array.isArray(config.apps)) return;

    for (const appCfg of config.apps) {
      const entry = coverage.find((c) => c.name === appCfg.name);
      if (!entry || entry.specCount > 0) continue; // already has counted specs

      const specDirAbs = path.isAbsolute(appCfg.specDir)
        ? appCfg.specDir
        : path.join(workspaceRoot, appCfg.specDir);
      if (!fs.existsSync(specDirAbs)) continue;

      const mdFiles = fs.readdirSync(specDirAbs).filter((f) => f.endsWith('.md') && f !== 'README.md');
      if (mdFiles.length === 0) continue;

      entry.specCount = mdFiles.length;
      entry.percentage = entry.sourceCount > 0
        ? Math.round((mdFiles.length / entry.sourceCount) * 100)
        : 100; // no source files but has specs — treat as fully covered via import
      entry.items = mdFiles.map((f) => ({
        app: entry.name,
        key: f.replace(/\.md$/, ''),
        hasSpec: true,
        hasTest: false,
        specPath: path.join(specDirAbs, f),
      }));
    }
  } catch { /* best-effort */ }
}
