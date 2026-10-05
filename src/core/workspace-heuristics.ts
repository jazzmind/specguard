/**
 * Heuristics for `specguard workspace init`: repo keys and roles derived from
 * what a repo contains, not from how it is named.
 *
 * Spec: specs/core/workspace.md
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Directory name -> repo key. Lowercase, runs of other characters become `-`. */
export function workspaceRepoKey(dirName: string): string {
  return dirName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

const UI_DEPS = ['react', 'react-dom', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', '@angular/core', 'solid-js', 'preact', 'astro'];
const SERVER_DEPS = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', '@trpc/server', 'apollo-server', '@apollo/server', 'graphql-yoga', 'graphql', '@hapi/hapi'];
const E2E_FRAMEWORKS = new Set(['playwright', 'cypress', 'webdriverio', 'selenium']);
const SERVER_PY = /\b(fastapi|flask|django|starlette|aiohttp|sanic|tornado)\b/i;
const SERVER_JAVA = /spring-boot|quarkus|micronaut|jakarta/i;

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function packageDeps(dir: string): string[] {
  try {
    const pkg = JSON.parse(readText(path.join(dir, 'package.json'))) as Record<string, Record<string, string> | undefined>;
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  } catch {
    return [];
  }
}

function hasFileMatching(dir: string, test: (name: string) => boolean): boolean {
  try {
    return readdirSync(dir).some(test);
  } catch {
    return false;
  }
}

interface RepoConfigHint {
  frameworks: string[];
  languages: string[];
  hasApiSources: boolean;
  docsOnly: boolean;
}

function configHint(dir: string): RepoConfigHint {
  const hint: RepoConfigHint = { frameworks: [], languages: [], hasApiSources: false, docsOnly: false };
  try {
    const cfg = JSON.parse(readText(path.join(dir, '.specguard', 'config.json'))) as {
      apps?: Array<{ framework?: string; language?: string; sources?: Record<string, string[] | undefined> }>;
    };
    for (const app of cfg.apps ?? []) {
      if (app.framework) hint.frameworks.push(app.framework.toLowerCase());
      hint.languages.push(app.language ?? 'typescript');
      if ((app.sources?.api ?? []).length > 0) hint.hasApiSources = true;
    }
  } catch {
    /* no readable config */
  }
  return hint;
}

/** `test`, `docs`, `provider` (serves an API), or `consumer`. Decided from repo content. */
export function guessRepoRole(dir: string): 'test' | 'docs' | 'provider' | 'consumer' {
  const hint = configHint(dir);
  if (hint.frameworks.length > 0 && hint.frameworks.every((f) => E2E_FRAMEWORKS.has(f))) return 'test';
  const deps = packageDeps(dir);
  if (deps.length > 0 && deps.every((d) => d.startsWith('@playwright/') || d === 'playwright' || d === 'cypress' || d === 'typescript' || d.startsWith('@types/'))) {
    return 'test';
  }

  const hasCode = hint.languages.length > 0 || deps.length > 0 || hasFileMatching(dir, (n) => /^(go\.mod|Cargo\.toml|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?)$/.test(n));
  if (!hasCode && (existsSync(path.join(dir, 'mkdocs.yml')) || hasFileMatching(dir, (n) => /^docusaurus\.config\./.test(n)) || existsSync(path.join(dir, 'docs')))) {
    return 'docs';
  }

  const ui = deps.some((d) => UI_DEPS.includes(d));
  const server =
    deps.some((d) => SERVER_DEPS.includes(d)) ||
    hasFileMatching(dir, (n) => /^(openapi|swagger)\.(json|ya?ml)$/.test(n) || /\.graphql$/.test(n) || n === 'schema.graphql') ||
    SERVER_PY.test(readText(path.join(dir, 'pyproject.toml')) + readText(path.join(dir, 'requirements.txt'))) ||
    SERVER_JAVA.test(readText(path.join(dir, 'pom.xml')) + readText(path.join(dir, 'build.gradle'))) ||
    hint.hasApiSources;
  if (ui) return 'consumer';
  if (server) return 'provider';
  // No UI or server signal: non-JS ecosystems default to services, JS to consumers.
  if (existsSync(path.join(dir, 'go.mod')) || existsSync(path.join(dir, 'Cargo.toml')) || hint.languages.some((l) => ['python', 'go', 'rust', 'java'].includes(l))) {
    return 'provider';
  }
  return 'consumer';
}
