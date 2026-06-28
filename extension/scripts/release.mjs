#!/usr/bin/env node
/**
 * SpecGuard VS Code extension release script.
 *
 * Usage:
 *   node scripts/release.mjs [patch|minor|major] [--dry-run] [--no-package]
 *
 * What it does:
 *   1. Bumps the version in package.json (semver)
 *   2. Collects commits since the last git tag for release notes
 *   3. Prepends a new section to CHANGELOG.md
 *   4. Builds the extension (webview + host)
 *   5. Packages the .vsix (unless --no-package)
 *   6. Prints the next manual steps (git tag + publish)
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const bumpType = args.find((a) => ['patch', 'minor', 'major'].includes(a)) ?? 'patch';
const dryRun = args.includes('--dry-run');
const noPackage = args.includes('--no-package');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe', ...opts }).trim();
}

function git(args) {
  const res = spawnSync('git', args, { cwd: path.resolve(ROOT, '..'), encoding: 'utf-8' });
  return { stdout: (res.stdout ?? '').trim(), ok: res.status === 0 };
}

function bumpVersion(current, type) {
  const [maj, min, pat] = current.split('.').map(Number);
  if (type === 'major') return `${maj + 1}.0.0`;
  if (type === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function formatDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Collect changelog entries from git log
// ---------------------------------------------------------------------------

function collectCommits(currentVersion) {
  // Try to find the most recent tag matching the extension's version scheme
  const tagResult = git(['tag', '--sort=-version:refname', '--list', 'ext-v*']);
  const lastTag = tagResult.ok && tagResult.stdout ? tagResult.stdout.split('\n')[0] : null;

  let logRange = lastTag ? `${lastTag}..HEAD` : 'HEAD~20..HEAD';

  const logResult = git(['log', logRange, '--pretty=format:%s|%H|%an', '--no-merges']);
  if (!logResult.ok || !logResult.stdout) return [];

  return logResult.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [subject, hash, author] = line.split('|');
      return { subject: subject ?? '', hash: (hash ?? '').slice(0, 7), author: author ?? '' };
    });
}

function categoriseCommits(commits) {
  const categories = {
    '✨ New': [],
    '🐛 Fixed': [],
    '⚡ Improved': [],
    '🔧 Internal': [],
  };

  for (const c of commits) {
    const s = c.subject.toLowerCase();
    if (/^(feat|add|new)/.test(s)) categories['✨ New'].push(c);
    else if (/^(fix|bug|patch)/.test(s)) categories['🐛 Fixed'].push(c);
    else if (/^(perf|refactor|improve|update|enhance)/.test(s)) categories['⚡ Improved'].push(c);
    else categories['🔧 Internal'].push(c);
  }

  return categories;
}

function buildChangelogSection(newVersion, commits) {
  const date = formatDate();
  const categorised = categoriseCommits(commits);

  const lines = [`## [${newVersion}] — ${date}`, ''];

  let hasContent = false;
  for (const [label, entries] of Object.entries(categorised)) {
    if (entries.length === 0) continue;
    hasContent = true;
    lines.push(`### ${label}`);
    lines.push('');
    for (const e of entries) {
      lines.push(`- ${e.subject} (\`${e.hash}\`)`);
    }
    lines.push('');
  }

  if (!hasContent) {
    lines.push('_No notable changes collected from git log._');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
const currentVersion = pkg.version;
const newVersion = bumpVersion(currentVersion, bumpType);

console.log(`\nSpecGuard extension release`);
console.log(`  Current: ${currentVersion}`);
console.log(`  New:     ${newVersion}  (${bumpType} bump)`);
if (dryRun) console.log(`  Mode:    DRY RUN — no files will be modified\n`);
console.log('');

// Collect commits
const commits = collectCommits(currentVersion);
console.log(`  Collected ${commits.length} commit(s) since last ext tag`);

const newSection = buildChangelogSection(newVersion, commits);
console.log('\n--- Changelog section preview ---');
console.log(newSection);
console.log('---------------------------------\n');

if (dryRun) {
  console.log('Dry-run complete. Re-run without --dry-run to apply changes.');
  process.exit(0);
}

// 1. Update package.json version
pkg.version = newVersion;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
console.log(`✓ Updated package.json → ${newVersion}`);

// 2. Update CHANGELOG.md
const header = `# SpecGuard VS Code Extension — Changelog\n\nAll notable changes are documented here.\n\n`;
let existingBody = '';
if (fs.existsSync(CHANGELOG_PATH)) {
  const existing = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
  // Strip the header block if present so we can prepend cleanly
  existingBody = existing.replace(/^# .+\n(\n.+\n)?\n?/, '');
} else {
  existingBody = '';
}

fs.writeFileSync(CHANGELOG_PATH, header + newSection + existingBody, 'utf-8');
console.log(`✓ Updated CHANGELOG.md`);

// 3. Build
if (!noPackage) {
  console.log('\n⏳ Building extension...');
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
    console.log('✓ Build complete');
  } catch {
    console.error('✗ Build failed — fix errors, then run: npm run package');
    process.exit(1);
  }

  // 4. Package
  console.log('\n⏳ Packaging .vsix...');
  try {
    execSync('npm run package', { cwd: ROOT, stdio: 'inherit' });
    const vsix = fs.readdirSync(ROOT).find((f) => f.endsWith('.vsix'));
    console.log(`✓ Packaged: ${vsix ?? 'specguard-' + newVersion + '.vsix'}`);
  } catch {
    console.error('✗ Packaging failed');
    process.exit(1);
  }
}

// 5. Print next steps
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SpecGuard ${newVersion} ready to ship
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:
  git add extension/package.json extension/CHANGELOG.md
  git commit -m "chore(ext): release v${newVersion}"
  git tag ext-v${newVersion}
  git push && git push --tags

To publish to the VS Code Marketplace:
  cd extension && vsce publish
`);
