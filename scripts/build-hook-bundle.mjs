// Builds the agent edit guard as one self-contained file, so the Claude Code plugin runs it with no install step:
//   node scripts/build-hook-bundle.mjs                 -> plugins/specguard/hooks/dist/specguard-hook.mjs (committed)
//   node scripts/build-hook-bundle.mjs --also-dist     -> and dist/hooks/specguard-hook.mjs (shipped in the npm package)
//   node scripts/build-hook-bundle.mjs --out <file>    -> only that file (the freshness test builds into a temp dir)
// The output depends only on the sources, the dependency versions and the esbuild version - not on the package
// manager that installed them. esbuild keys each bundled module by the path it resolved, and npm (flat
// node_modules) and pnpm (node_modules/.pnpm/<name>@<version>/node_modules/<name>) hand it different paths for
// the same file; a half-mixed install can even hand it two copies of one package. The sgCanonicalDeps plugin
// below pins every bare import to one canonical copy, and normalizeModuleLabels rewrites the module labels in
// the output to node_modules/<name>/<subpath>, so an npm install and a pnpm install build byte-identical bundles.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const outFile = flagValue('--out');
const targets = outFile
  ? [path.resolve(outFile)]
  : [path.join(root, 'plugins', 'specguard', 'hooks', 'dist', 'specguard-hook.mjs'), ...(args.includes('--also-dist') ? [path.join(root, 'dist', 'hooks', 'specguard-hook.mjs')] : [])];

// Some bundled dependencies are CommonJS and `require` node built-ins; an ES module has no `require`.
const banner = "import { createRequire as __sgCreateRequire } from 'node:module'; const require = __sgCreateRequire(import.meta.url);";

// --- Layout-independent dependency resolution --------------------------------------------------------
// Every bare import is resolved (by esbuild, with the build's own conditions) and then re-pointed at one
// canonical copy of the logical module: the pnpm virtual store first, the flat top-level copy second, and
// whatever the layout resolved as a last resort. That makes the module graph - and therefore the bytes -
// independent of which installer (or mix of installers) produced node_modules.

/** [pkgRoot, name, subpath] for a file under some node_modules directory, or null if it is not one. */
function packageInfo(file) {
  const rel = path.relative(root, file).split(path.sep);
  const nm = rel.lastIndexOf('node_modules');
  if (nm === -1 || nm + 1 >= rel.length) return null;
  const rest = rel.slice(nm + 1);
  const depth = rest[0].startsWith('@') ? 2 : 1;
  const name = rest.slice(0, depth).join('/');
  if (!name || name === '.pnpm') return null;
  return { pkgRoot: path.join(root, ...rel.slice(0, nm + 1 + depth)), name, sub: rest.slice(depth).join('/') };
}

const versions = new Map();
function versionOf(pkgRoot) {
  if (!versions.has(pkgRoot)) {
    try {
      versions.set(pkgRoot, JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version ?? null);
    } catch {
      versions.set(pkgRoot, null);
    }
  }
  return versions.get(pkgRoot);
}

/** The deterministic realpath of <name>@<version> in the pnpm virtual store, if one exists. */
function storeCopy(name, version) {
  if (!version) return null;
  const dir = path.join(root, 'node_modules', '.pnpm');
  if (!existsSync(dir)) return null;
  const prefix = (name.startsWith('@') ? name.replace('/', '+') : name) + '@' + version;
  const hit = readdirSync(dir)
    .filter((entry) => entry === prefix || entry.startsWith(prefix + '_'))
    .map((entry) => path.join(dir, entry, 'node_modules', name))
    .filter((cand) => existsSync(cand))
    .sort()[0];
  return hit ? realpathSync(hit) : null;
}

/** The realpath of the flat top-level copy: the whole package under npm, or the pnpm symlink into the store. */
function topLevelCopy(name, version) {
  const cand = path.join(root, 'node_modules', name);
  if (!existsSync(cand)) return null;
  const rp = realpathSync(cand);
  if (version && versionOf(rp) !== version) return null; // a stale leftover of another version: not this module
  return rp;
}

const winners = new Map();
function canonicalFile(name, version, sub, resolvedRealpath) {
  const key = `${name}@${version ?? '?'}`;
  if (!winners.has(key)) winners.set(key, storeCopy(name, version) ?? topLevelCopy(name, version));
  const canonRoot = winners.get(key);
  if (canonRoot) {
    const file = path.join(canonRoot, sub);
    if (existsSync(file)) return file; // the canonical copy of this file
  }
  return resolvedRealpath; // no canonical copy found: keep what the layout resolved
}

const sgCanonicalDeps = {
  name: 'sg-canonical-deps',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData?.sgCanonical) return undefined; // the b.resolve call below must not re-enter this plugin
      let resolved;
      try {
        resolved = await b.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { sgCanonical: true } });
      } catch {
        return undefined; // let esbuild report the unresolvable import itself
      }
      if (!resolved?.path || resolved.external || !existsSync(resolved.path)) return undefined; // built-in or virtual
      const real = realpathSync(resolved.path);
      const info = packageInfo(real);
      if (!info) return undefined; // a workspace file, not a dependency
      return { path: canonicalFile(info.name, versionOf(info.pkgRoot), info.sub, real) };
    });
  },
};

// esbuild prints paths relative to the working directory in its module comments: build from the repository root.
process.chdir(root);
const result = await build({
  entryPoints: ['src/hooks/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  write: false,
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: banner },
  plugins: [sgCanonicalDeps],
  logLevel: 'warning',
});

/** Rewrite the module labels esbuild embedded (the `// path` comments and the __commonJS keys) from layout
 * specific paths - node_modules/.pnpm/<name>@<version>[_peers]/node_modules/<name>/... under pnpm - to the
 * canonical node_modules/<name>/<subpath> form, so both installers produce identical bytes. */
function normalizeModuleLabels(text) {
  const labels = new Set();
  for (const m of text.matchAll(/^\/\/ (node_modules\/\S+)$/gm)) labels.add(m[1]);
  for (const m of text.matchAll(/"(node_modules\/[^"]+)"\(exports/g)) labels.add(m[1]);
  const entries = [];
  for (const label of labels) {
    const store = label.match(/^node_modules\/\.pnpm\/([^/]+)\/node_modules\/(.+)$/);
    const rest = store ? store[2] : label.slice('node_modules/'.length);
    const depth = rest.startsWith('@') ? 2 : 1;
    const parts = rest.split('/');
    const name = parts.slice(0, depth).join('/');
    let version = null;
    if (store) {
      const at = store[1].startsWith('@') ? store[1].indexOf('@', 1) : store[1].indexOf('@');
      version = at === -1 ? null : store[1].slice(at + 1).split('_')[0];
    } else {
      version = versionOf(path.join(root, 'node_modules', name));
    }
    entries.push({ label, name, sub: parts.slice(depth).join('/'), version });
  }
  // If one package name really has two versions in the tree, disambiguate the labels with @<version>.
  const versionSets = new Map();
  for (const e of entries) if (e.version) versionSets.set(e.name, (versionSets.get(e.name) ?? new Set()).add(e.version));
  const ambiguous = (name) => (versionSets.get(name)?.size ?? 0) > 1;
  const replacements = entries
    .map((e) => [e.label, `node_modules/${e.name}${ambiguous(e.name) && e.version ? '@' + e.version : ''}/${e.sub}`])
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of replacements) text = text.split(from).join(to);
  return text;
}

const text = normalizeModuleLabels(result.outputFiles[0].text);
for (const file of targets) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  process.stdout.write(`built ${path.relative(root, file) || file} (${Math.round(text.length / 1024)} KB)\n`);
}