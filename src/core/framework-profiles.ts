/**
 * Framework profiles for `specguard index`.
 *
 * Spec: specs/core/framework-profiles.md
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expandGlobs } from './reader.js';

export type Surface = 'routes' | 'endpoints';

export interface FrameworkProfile {
  id: string;
  label: string;
  /** What the entry points declare. */
  surface: Surface;
  /** Code-fence language for excerpts. */
  fence: string;
  /** Files (paths or globs relative to the repo) that usually declare routes or endpoints. */
  entryPoints: string[];
  /** Extra guidance for the prompt. */
  hint: string;
}

const PROFILES: FrameworkProfile[] = [
  {
    id: 'next',
    label: 'Next.js',
    surface: 'routes',
    fence: 'tsx',
    entryPoints: ['app/layout.tsx', 'app/page.tsx', 'src/app/layout.tsx', 'src/app/page.tsx', 'pages/_app.tsx', 'pages/index.tsx', 'src/pages/_app.tsx', 'next.config.*'],
    hint: 'Routes are the directories under app/ or pages/.',
  },
  {
    id: 'react',
    label: 'React',
    surface: 'routes',
    fence: 'tsx',
    entryPoints: ['src/App.tsx', 'src/App.jsx', 'src/app.tsx', 'src/router.tsx', 'src/router.ts', 'src/routes.tsx', 'src/main.tsx', 'src/main.ts', 'src/index.tsx'],
    hint: 'If the source shows React context providers, describe the provider tree.',
  },
  {
    id: 'vue',
    label: 'Vue',
    surface: 'routes',
    fence: 'ts',
    entryPoints: ['src/router/index.ts', 'src/router.ts', 'src/App.vue', 'src/main.ts'],
    hint: 'Routes are the vue-router route records.',
  },
  {
    id: 'angular',
    label: 'Angular',
    surface: 'routes',
    fence: 'ts',
    entryPoints: ['src/app/app.routes.ts', 'src/app/app-routing.module.ts', 'src/app/app.module.ts', 'src/main.ts'],
    hint: 'Routes are the Routes arrays and lazy-loaded children.',
  },
  {
    id: 'svelte',
    label: 'SvelteKit / Svelte',
    surface: 'routes',
    fence: 'ts',
    entryPoints: ['src/routes/+layout.svelte', 'src/routes/+page.svelte', 'src/App.svelte', 'src/main.ts'],
    hint: 'Routes are the directories under src/routes.',
  },
  {
    id: 'express',
    label: 'Express',
    surface: 'endpoints',
    fence: 'ts',
    entryPoints: ['src/server.ts', 'src/app.ts', 'src/index.ts', 'server.js', 'app.js', 'index.js', 'src/routes/index.ts'],
    hint: 'Endpoints are app.use / router.get|post|put|delete calls with their mount paths.',
  },
  {
    id: 'fastify',
    label: 'Fastify',
    surface: 'endpoints',
    fence: 'ts',
    entryPoints: ['src/server.ts', 'src/app.ts', 'src/index.ts', 'server.js', 'app.js'],
    hint: 'Endpoints are fastify.get|post|... registrations and registered plugins with prefixes.',
  },
  {
    id: 'nestjs',
    label: 'NestJS',
    surface: 'endpoints',
    fence: 'ts',
    entryPoints: ['src/main.ts', 'src/app.module.ts', 'src/**/*.controller.ts'],
    hint: 'Endpoints are @Controller prefixes plus @Get/@Post/... decorators.',
  },
  {
    id: 'fastapi',
    label: 'FastAPI',
    surface: 'endpoints',
    fence: 'python',
    entryPoints: ['main.py', 'app/main.py', 'src/main.py', 'app/api/**/*.py', 'src/**/routers/*.py'],
    hint: 'Endpoints are @app.get|post|... and APIRouter routes with their prefixes.',
  },
  {
    id: 'flask',
    label: 'Flask',
    surface: 'endpoints',
    fence: 'python',
    entryPoints: ['app.py', 'wsgi.py', 'main.py', 'app/__init__.py', 'app/routes.py', 'src/app.py'],
    hint: 'Endpoints are @app.route / blueprint routes.',
  },
  {
    id: 'django',
    label: 'Django',
    surface: 'endpoints',
    fence: 'python',
    entryPoints: ['urls.py', '*/urls.py', 'config/urls.py', 'manage.py'],
    hint: 'Endpoints are urlpatterns entries (path/re_path/include).',
  },
  {
    id: 'go-http',
    label: 'Go HTTP',
    surface: 'endpoints',
    fence: 'go',
    entryPoints: ['main.go', 'cmd/*/main.go', 'internal/**/router.go', 'internal/**/routes.go', 'routes.go', 'server.go'],
    hint: 'Endpoints are mux/router registrations (http.HandleFunc, chi, gin, echo).',
  },
  {
    id: 'spring',
    label: 'Spring',
    surface: 'endpoints',
    fence: 'java',
    entryPoints: ['src/main/java/**/*Controller.java', 'src/main/java/**/*Application.java'],
    hint: 'Endpoints are @RequestMapping / @GetMapping / @PostMapping methods.',
  },
];

const GENERIC: FrameworkProfile = {
  id: 'generic',
  label: 'Generic',
  surface: 'endpoints',
  fence: '',
  entryPoints: ['src/index.ts', 'src/main.ts', 'src/index.js', 'main.py', 'main.go', 'src/main.rs', 'README.md'],
  hint: 'Describe the public entry points (routes, endpoints, or commands) you can see.',
};

export function getFrameworkProfile(id: string): FrameworkProfile | undefined {
  return PROFILES.find((profile) => profile.id === id) ?? (id === 'generic' ? GENERIC : undefined);
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function depNames(repoDir: string): Set<string> {
  try {
    const pkg = JSON.parse(readText(path.join(repoDir, 'package.json'))) as Record<string, Record<string, string> | undefined>;
    return new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
  } catch {
    return new Set();
  }
}

/** Pick the profile for a repo from its dependency manifests. Order matters: meta-frameworks before libraries. */
export function detectFramework(repoDir: string, app?: { framework?: string; language?: string }): FrameworkProfile {
  const deps = depNames(repoDir);
  const has = (...names: string[]) => names.some((name) => deps.has(name));
  if (has('next')) return PROFILES.find((p) => p.id === 'next') as FrameworkProfile;
  if (has('@angular/core')) return PROFILES.find((p) => p.id === 'angular') as FrameworkProfile;
  if (has('@nestjs/core')) return PROFILES.find((p) => p.id === 'nestjs') as FrameworkProfile;
  if (has('vue', 'nuxt')) return PROFILES.find((p) => p.id === 'vue') as FrameworkProfile;
  if (has('svelte', '@sveltejs/kit')) return PROFILES.find((p) => p.id === 'svelte') as FrameworkProfile;
  if (has('react', 'react-dom')) return PROFILES.find((p) => p.id === 'react') as FrameworkProfile;
  if (has('fastify')) return PROFILES.find((p) => p.id === 'fastify') as FrameworkProfile;
  if (has('express')) return PROFILES.find((p) => p.id === 'express') as FrameworkProfile;

  const py = `${readText(path.join(repoDir, 'requirements.txt'))}\n${readText(path.join(repoDir, 'pyproject.toml'))}`.toLowerCase();
  if (/\bfastapi\b/.test(py)) return PROFILES.find((p) => p.id === 'fastapi') as FrameworkProfile;
  if (/\bdjango\b/.test(py)) return PROFILES.find((p) => p.id === 'django') as FrameworkProfile;
  if (/\bflask\b/.test(py)) return PROFILES.find((p) => p.id === 'flask') as FrameworkProfile;

  const goMod = readText(path.join(repoDir, 'go.mod'));
  if (goMod || app?.language === 'go') return PROFILES.find((p) => p.id === 'go-http') as FrameworkProfile;
  const java = `${readText(path.join(repoDir, 'pom.xml'))}${readText(path.join(repoDir, 'build.gradle'))}`;
  if (/spring/i.test(java)) return PROFILES.find((p) => p.id === 'spring') as FrameworkProfile;
  return GENERIC;
}

export interface EntrySource {
  /** Repo-relative POSIX path. */
  file: string;
  source: string;
}

/**
 * Read routing source. `app.entryPoints` replaces the profile's list. Paths and
 * globs are resolved from the repo; the first matches are read, each capped at
 * `perFileChars`, up to `maxFiles` files.
 */
export async function readEntryPoints(
  repoDir: string,
  profile: FrameworkProfile,
  app?: { entryPoints?: string[] },
  limits: { maxFiles?: number; perFileChars?: number } = {},
): Promise<EntrySource[]> {
  const maxFiles = limits.maxFiles ?? 3;
  const perFile = limits.perFileChars ?? 4000;
  const candidates = app?.entryPoints?.length ? app.entryPoints : profile.entryPoints;
  const out: EntrySource[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const matches = /[*?{}[\]]/.test(candidate)
      ? await expandGlobs([candidate], repoDir).catch(() => [] as string[])
      : [path.join(repoDir, candidate)].filter((file) => existsSync(file));
    for (const abs of matches) {
      if (seen.has(abs) || out.length >= maxFiles) continue;
      seen.add(abs);
      out.push({ file: path.relative(repoDir, abs).split(path.sep).join('/'), source: readText(abs).slice(0, perFile) });
    }
    if (out.length >= maxFiles) break;
  }
  return out;
}
