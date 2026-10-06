/**
 * Redaction for text that leaves the machine: DOM, accessibility snapshots,
 * console errors. Built-in masks cover email addresses, phone numbers, US
 * Social Security numbers, payment card numbers, bearer tokens, JWTs and common
 * API-key shapes. Projects add patterns, CSS selectors to blank, and a hook.
 *
 * Spec: specs/core/redact.md
 */
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
  { name: 'bearer', regex: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi, replace: '$1 [TOKEN]' },
  { name: 'api-key', regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, replace: '[KEY]' },
  { name: 'email', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, replace: '[EMAIL]' },
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

const noop: Redactor = { text: (t) => t, blankSelectors: [] };

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
      if (hook) {
        try {
          out = hook(out, kind);
        } catch {
          // A failing hook must not leak the unredacted text: keep the built-in result.
        }
      }
      return out;
    },
  };
}

/** Load the hook module named in config. A missing or invalid hook is an error: silently skipping it would leak. */
export async function loadRedactHook(rootDir: string, hookPath: string): Promise<RedactHook> {
  const abs = path.resolve(rootDir, hookPath);
  const rel = path.relative(rootDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`redaction hook ${hookPath} must be inside the project`);
  }
  if (!existsSync(abs)) throw new Error(`redaction hook not found: ${hookPath}`);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown; redact?: unknown };
  const fn = typeof mod.default === 'function' ? mod.default : mod.redact;
  if (typeof fn !== 'function') throw new Error(`redaction hook ${hookPath} must export a default function (text, kind) => string`);
  return fn as RedactHook;
}
