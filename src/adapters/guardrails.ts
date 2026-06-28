/**
 * Guardrails adapter.
 *
 * Classifies browser actions before execution to prevent destructive or
 * outbound side-effects during automated validation/healing. Classification is
 * purely keyword-based (deterministic, no LLM). Never throws.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a proposed browser action description.
 * Matching is case-insensitive and checks for keyword presence anywhere in
 * the description string.
 */
export function classifyAction(description: string): ActionClassification {
  const lower = description.toLowerCase();

  for (const kw of DESTRUCTIVE_KEYWORDS) {
    if (lower.includes(kw)) return 'destructive';
  }

  for (const kw of OUTBOUND_KEYWORDS) {
    if (lower.includes(kw)) return 'outbound';
  }

  return 'safe';
}

/** Returns `true` for classifications that should be blocked. */
export function isBlocked(classification: ActionClassification): boolean {
  return classification === 'destructive' || classification === 'outbound';
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
