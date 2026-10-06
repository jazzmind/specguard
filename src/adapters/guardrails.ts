/**
 * Guardrails adapter.
 *
 * Classifies browser actions before execution to prevent destructive or
 * outbound side-effects during automated validation/healing. Classification is
 * deterministic (no LLM) and never throws.
 *
 * Matching is by whole word (with simple inflections), never by substring, so
 * "postcode" does not match "post". When the action's TARGET element is known,
 * its role and accessible name decide: filling a text field is safe, and only a
 * control that can trigger something (button, link, submit input, menu item) is
 * judged by its own name, not by the planner's free-text description.
 *
 * Spec: specs/adapters/guardrails.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Safety classification of a proposed browser action. */
export type ActionClassification = 'safe' | 'destructive' | 'outbound';

/** A browser action that was blocked by the guardrail. */
export interface BlockedAction {
  description: string;
  classification: ActionClassification;
  reason: string;
}

/** What is known about the element an action will touch. */
export interface ActionTarget {
  /** ARIA role (explicit or implicit): button, link, textbox, menuitem, ... */
  role?: string;
  /** Accessible name: label, aria-label, or visible text. */
  name?: string;
  /** Lower-case tag name. */
  tag?: string;
  /** `type` attribute of an input. */
  type?: string;
}

/** Project-level additions to the built-in word lists (`validate.guardrails`). */
export interface GuardrailPolicy {
  /** Words or phrases that always block, classified destructive. */
  deny?: string[];
  /** Words or phrases that are always safe when they appear in the target's name or the description. */
  allow?: string[];
  /** Staging: let outbound actions run. Destructive actions stay blocked. */
  allowOutbound?: boolean;
}

// ---------------------------------------------------------------------------
// Keyword lists
// ---------------------------------------------------------------------------

const DESTRUCTIVE_KEYWORDS = [
  'delete',
  'remove',
  'archive',
  'purge',
  'drop',
  'destroy',
  'reset',
  'wipe',
  'erase',
  'clear all',
  'bulk delete',
  'mass delete',
];

const OUTBOUND_KEYWORDS = [
  'send',
  'invite',
  'share',
  'publish',
  'pay',
  'submit',
  'transfer',
  'broadcast',
  'post',
  'email',
  'notify',
  'message',
  'dispatch',
];

/** Irregular forms the suffix rule below cannot produce. */
const IRREGULAR: Record<string, string[]> = { send: ['sent'], drop: ['dropped', 'dropping'], pay: ['paid'] };

/** Roles whose activation can have a side effect. */
const ACTIVATING_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'switch']);

/** Roles that only hold text: typing into them changes nothing until something is activated. */
const TEXT_ENTRY_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `delete` also matches deletes, deleted, deleting; `post` does not match postcode or poster. */
function phraseRegex(phrase: string): RegExp {
  const words = phrase.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const parts = words.map((word, index) => {
    const last = index === words.length - 1;
    if (!last) return escapeRegex(word);
    const irregular = (IRREGULAR[word] ?? []).map(escapeRegex).join('|');
    const stem = word.endsWith('e') ? word.slice(0, -1) : word;
    const forms = `${escapeRegex(stem)}(?:e|es|ed|ing|s|d)?`;
    return irregular ? `(?:${forms}|${irregular})` : forms;
  });
  return new RegExp(`(?<![a-z0-9])${parts.join('[^a-z0-9]+')}(?![a-z0-9])`, 'i');
}

/** Split camelCase and snake/kebab so `removeButton` and `delete_account` read as words. */
function normalizeText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .toLowerCase();
}

function matchesAny(text: string, phrases: string[]): boolean {
  const normalized = normalizeText(text);
  return phrases.some((phrase) => phraseRegex(phrase).test(normalized));
}

function classifyText(text: string): ActionClassification {
  if (matchesAny(text, DESTRUCTIVE_KEYWORDS)) return 'destructive';
  if (matchesAny(text, OUTBOUND_KEYWORDS)) return 'outbound';
  return 'safe';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a proposed browser action.
 *
 * With a `target`: a text-entry field is safe; an activating control (button,
 * link, menu item, submit/button input) is judged by its accessible name; other
 * elements fall back to the description. Without a target the description is
 * judged by whole words. `policy.deny` blocks and `policy.allow` permits
 * regardless of the built-in lists.
 */
export function classifyAction(
  description: string,
  target?: ActionTarget,
  policy?: GuardrailPolicy,
): ActionClassification {
  const name = target?.name?.trim() ?? '';
  const subject = name || description;

  if (policy?.deny?.length && (matchesAny(subject, policy.deny) || matchesAny(description, policy.deny))) {
    return 'destructive';
  }
  if (policy?.allow?.length && matchesAny(subject, policy.allow)) return 'safe';

  if (target && (target.role || target.tag)) {
    const role = (target.role ?? '').toLowerCase();
    const tag = (target.tag ?? '').toLowerCase();
    const inputType = (target.type ?? '').toLowerCase();
    const isSubmitInput = tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(inputType);
    const activating = ACTIVATING_ROLES.has(role) || tag === 'button' || tag === 'a' || isSubmitInput;
    const textEntry = TEXT_ENTRY_ROLES.has(role) || tag === 'textarea' || (tag === 'input' && !isSubmitInput);
    if (textEntry && !activating) return 'safe';
    if (activating) {
      // A control with no accessible name falls back to the planner's description.
      return classifyText(name || description);
    }
  }

  return classifyText(description);
}

/** Returns `true` for classifications that should be blocked. */
export function isBlocked(classification: ActionClassification, policy?: GuardrailPolicy): boolean {
  if (classification === 'destructive') return true;
  if (classification === 'outbound') return policy?.allowOutbound !== true;
  return false;
}

/**
 * Build a `BlockedAction` record for an action that was not executed.
 */
export function makeBlockedAction(
  description: string,
  classification: ActionClassification,
): BlockedAction {
  const reason =
    classification === 'destructive'
      ? `Action matches destructive keyword pattern — blocked to prevent data loss`
      : `Action matches outbound keyword pattern — blocked to prevent unintended external communication`;

  return { description, classification, reason };
}
