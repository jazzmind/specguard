/**
 * Redaction for text that leaves the machine: DOM, accessibility snapshots,
 * console errors. Built-in masks cover email addresses, phone numbers, US
 * Social Security numbers, payment card numbers, bearer tokens, JWTs and common
 * API-key shapes. Projects add patterns, CSS selectors to blank, and a hook.
 *
 * Spec: specs/capabilities/platform-foundation.md
 */
import { isInside } from './safe-path.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RedactionConfig {
  /** Apply the built-in masks. Default true. */
  builtin?: boolean;
  /** Extra regular expressions (source strings, case-insensitive) replaced with `[REDACTED]`. */
  patterns?: string[];
  /** CSS selectors whose text and values are blanked before the page is read or photographed. */
  blankSelectors?: string[];
  /** Module (relative to the config root) whose default export is `(text, kind) => string`. */
  hookPath?: string;
}

export type RedactKind = 'dom' | 'a11y' | 'console' | 'text';

export type RedactHook = (text: string, kind: RedactKind) => string;

export interface Redactor {
  /** Mask `text`. The result never contains what a built-in mask or pattern matched. */
  text(text: string, kind?: RedactKind): string;
  /** Selectors to blank in the page. */
  blankSelectors: string[];
}

/** Luhn check, so a long order number is not mistaken for a card. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

interface Mask {
  name: string;
  regex: RegExp;
  replace: string | ((match: string) => string);
}

export const BUILTIN_MASKS: Mask[] = [
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: '[TOKEN]' },
  // A credential has a digit or `=` in it; "Basic requirements" and "Bearer tokenization" are prose.
  { name: 'bearer', regex: /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]{10,})(?=[A-Za-z0-9._~+/=-]*[0-9=])[A-Za-z0-9._~+/=-]+/gi, replace: '$1 [TOKEN]' },
  { name: 'api-key', regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, replace: '[KEY]' },
  { name: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: '[PRIVATE KEY]' },
  {
    name: 'credential',
    // `password=hunter2`, `secret: "value"`. An unquoted value needs a digit, so `token: string` in a type is left alone.
    regex: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)(\s*[:=]\s*)(?:(["'])[^"'\n]{4,}\3|(?=[^\s"',;]*\d)[^\s"',;]{4,})/gi,
    replace: '$1$2[SECRET]',
  },
  // The local part is bounded and must start at a boundary, so a long run with no `@` costs one pass, not one per start.
  { name: 'email', regex: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,}/g, replace: '[EMAIL]' },
  { name: 'ssn', regex: /(?<![\d-])\d{3}[- ]\d{2}[- ]\d{4}(?![\d-])/g, replace: '[SSN]' },
  {
    name: 'card',
    regex: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    replace: (m) => (luhnValid(m.replace(/[ -]/g, '')) ? '[CARD]' : m),
  },
  {
    name: 'phone',
    // +country forms and NANP forms: (555) 123-4567, 555-123-4567, 555.123.4567, +1 555 123 4567
    regex: /(?<![\w-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])|(?<![\w])\+\d{1,3}(?:[\s.-]?\d{2,4}){2,4}(?![\w])/g,
    replace: '[PHONE]',
  },
];

/** Masks for credentials and tokens only: no personal-data masks (email, phone, SSN, card). */
const SECRET_MASKS = new Set(['jwt', 'bearer', 'api-key', 'private-key', 'credential']);

/**
 * Redactor for content that leaves the machine through the docs API. It masks
 * credentials and tokens but not personal data, which specs legitimately name.
 */
export function createSecretRedactor(): Redactor {
  const masks = BUILTIN_MASKS.filter((m) => SECRET_MASKS.has(m.name));
  return {
    blankSelectors: [],
    text(input: string): string {
      let out = input;
      for (const mask of masks) out = out.replace(mask.regex, mask.replace as string);
      return out;
    },
  };
}

const noop: Redactor = { text: (t) => t, blankSelectors: [] };

/** The largest text a hook may return, so a broken hook cannot flood a prompt or a log. */
export const MAX_HOOK_RESULT_CHARS = 2_000_000;

/** Raised when a redaction hook fails: the text is not sent or written, because it may not be redacted. */
export class RedactionHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionHookError';
  }
}

/**
 * Run the project's hook. It must return a string within `MAX_HOOK_RESULT_CHARS`; a throw, a promise (the hook is
 * synchronous) or any other result fails closed with `RedactionHookError`, since carrying on would send text the
 * project's own rules never saw.
 */
function runHook(hook: RedactHook, text: string, kind: RedactKind): string {
  let result: unknown;
  try {
    result = hook(text, kind);
  } catch (err) {
    throw new RedactionHookError(`the redaction hook threw: ${(err as Error).message}`);
  }
  if (typeof result !== 'string') throw new RedactionHookError(`the redaction hook must return a string, not ${result instanceof Promise ? 'a promise (hooks are synchronous)' : typeof result}`);
  if (result.length > MAX_HOOK_RESULT_CHARS) throw new RedactionHookError(`the redaction hook returned ${result.length} characters, over the limit of ${MAX_HOOK_RESULT_CHARS}`);
  return result;
}

/** Build a redactor from config. Returns an identity redactor for `builtin: false` with nothing else set. */
export function createRedactor(config?: RedactionConfig, hook?: RedactHook): Redactor {
  const builtin = config?.builtin !== false;
  const custom: RegExp[] = [];
  for (const source of config?.patterns ?? []) {
    try {
      custom.push(new RegExp(source, 'gi'));
    } catch {
      // A bad pattern must not disable redaction for the rest.
    }
  }
  const blankSelectors = config?.blankSelectors ?? [];
  if (!builtin && custom.length === 0 && !hook && blankSelectors.length === 0) return noop;

  return {
    blankSelectors,
    text(input: string, kind: RedactKind = 'text'): string {
      let out = input;
      if (builtin) {
        for (const mask of BUILTIN_MASKS) {
          out = out.replace(mask.regex, mask.replace as string);
        }
      }
      for (const regex of custom) out = out.replace(regex, '[REDACTED]');
      if (hook) out = runHook(hook, out, kind);
      return out;
    },
  };
}

/** Load the hook module named in config. A missing or invalid hook is an error: silently skipping it would leak. */
export async function loadRedactHook(rootDir: string, hookPath: string): Promise<RedactHook> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(hookPath) && !/^[a-z]:[\\/]/i.test(hookPath)) throw new Error(`redaction hook ${hookPath} must be a path inside the project, not a URL`);
  const abs = path.resolve(rootDir, hookPath);
  // Symlinks are resolved first: a link inside the project that points elsewhere is not inside it.
  if (!isInside(rootDir, abs)) throw new Error(`redaction hook ${hookPath} must be inside the project`);
  if (!existsSync(abs)) throw new Error(`redaction hook not found: ${hookPath}`);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown; redact?: unknown };
  const fn = typeof mod.default === 'function' ? mod.default : mod.redact;
  if (typeof fn !== 'function') throw new Error(`redaction hook ${hookPath} must export a default function (text, kind) => string`);
  return fn as RedactHook;
}
