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

    // Normal summary line: "N source files, N specs (N%), N tests"
    const summary = section.match(/(\d+) source files, (\d+) specs \((\d+)%\), (\d+) tests/);
    // Spec-first summary line: "0 source files (spec-first), N specs imported, N tests"
    const specFirstSummary = !summary ? section.match(/0 source files \(spec-first\), (\d+) specs imported, (\d+) tests/) : null;

    const sourceCount = summary ? parseInt(summary[1], 10) : 0;
    const specCount = summary
      ? parseInt(summary[2], 10)
      : specFirstSummary
        ? parseInt(specFirstSummary[1], 10)
        : items.filter((i) => i.hasSpec).length;
    const percentage = summary ? parseInt(summary[3], 10) : (specCount > 0 ? 100 : 0);
    const testCount = summary
      ? parseInt(summary[4], 10)
      : specFirstSummary
        ? parseInt(specFirstSummary[2], 10)
        : items.filter((i) => i.hasTest).length;
    apps.push({ name, specCount, sourceCount, testCount, percentage, items });
  }
  return apps;
}

/**
 * Recursively collect all `.md` files under `dir`, excluding `README.md`.
 * Returns absolute paths.
 */
function walkMdFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...walkMdFiles(full));
    } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') {
      results.push(full);
    }
  }
  return results;
}

/**
 * For apps where `status` reports 0 source files (e.g. specs created via
 * `import` from a PRD, with no matching source code), augment the coverage
 * data by directly counting `.md` files in each app's specDir so the
 * dashboard and sidebar reflect reality rather than showing 0 specs.
 *
 * Reads `.specguard/config.json` from `workspaceRoot` to discover specDirs.
 * Traverses subdirectories recursively so nested specs (e.g. specs/auth/login.md)
 * are counted correctly.
 */
export function augmentCoverageFromDisk(coverage: AppCoverage[], workspaceRoot: string): void {
  try {
    const configFile = path.join(workspaceRoot, '.specguard', 'config.json');
    if (!fs.existsSync(configFile)) return;
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as {
      apps?: Array<{ name: string; specDir: string; testOutput?: string }>;
    };
    if (!Array.isArray(config.apps)) return;

    for (const appCfg of config.apps) {
      const entry = coverage.find((c) => c.name === appCfg.name);
      if (!entry || entry.specCount > 0) continue; // already has counted specs

      const specDirAbs = path.isAbsolute(appCfg.specDir)
        ? appCfg.specDir
        : path.join(workspaceRoot, appCfg.specDir);
      if (!fs.existsSync(specDirAbs)) continue;

      // Recursive walk — picks up specs in subdirectories (e.g. specs/auth/login.md)
      const mdAbsPaths = walkMdFiles(specDirAbs);
      if (mdAbsPaths.length === 0) continue;

      // Resolve testOutput so we can check for generated tests.
      const testOutputAbs = appCfg.testOutput
        ? (path.isAbsolute(appCfg.testOutput) ? appCfg.testOutput : path.join(workspaceRoot, appCfg.testOutput))
        : null;

      let testCount = 0;
      entry.specCount = mdAbsPaths.length;
      entry.percentage = entry.sourceCount > 0
        ? Math.round((mdAbsPaths.length / entry.sourceCount) * 100)
        : 100; // no source files but has specs — treat as fully covered via import
      entry.items = mdAbsPaths.map((absPath) => {
        // Derive a feature key relative to the specDir (preserving subdirectory structure)
        const rel = path.relative(specDirAbs, absPath);
        const feature = rel.replace(/\.md$/, '').replace(/\\/g, '/');
        let hasTest = false;
        if (testOutputAbs) {
          // Check the same candidate paths that status.ts uses.
          const exts = ['ts', 'tsx', 'js', 'jsx'];
          const kinds = ['test', 'spec'];
          for (const kind of kinds) {
            for (const ext of exts) {
              const candidate = path.join(testOutputAbs, `${feature}.${kind}.${ext}`);
              if (fs.existsSync(candidate)) { hasTest = true; break; }
            }
            if (hasTest) break;
          }
        }
        if (hasTest) testCount += 1;
        return {
          app: entry.name,
          key: feature,
          hasSpec: true,
          hasTest,
          specPath: absPath,
        };
      });
      entry.testCount = testCount;
    }
  } catch { /* best-effort */ }
}
