import { describe, it, expect } from 'vitest';
import { classifyAction, isBlocked, makeBlockedAction } from '../../src/adapters/guardrails.js';

describe('classifyAction', () => {
  it('scenario 1: destructive keywords', () => {
    expect(classifyAction('Delete this record')).toBe('destructive');
    expect(classifyAction('Remove the selected items')).toBe('destructive');
    expect(classifyAction('Archive old entries')).toBe('destructive');
    expect(classifyAction('Purge all logs')).toBe('destructive');
    expect(classifyAction('Drop this table')).toBe('destructive');
    expect(classifyAction('Wipe the cache')).toBe('destructive');
    expect(classifyAction('Erase user data')).toBe('destructive');
  });

  it('scenario 2: outbound keywords', () => {
    expect(classifyAction('Send email invitation to user')).toBe('outbound');
    expect(classifyAction('Invite colleague to project')).toBe('outbound');
    expect(classifyAction('Share this document')).toBe('outbound');
    expect(classifyAction('Publish the post')).toBe('outbound');
    expect(classifyAction('Pay for subscription')).toBe('outbound');
    expect(classifyAction('Submit the payment form')).toBe('outbound');
    expect(classifyAction('Transfer funds to account')).toBe('outbound');
    expect(classifyAction('Broadcast announcement')).toBe('outbound');
  });

  it('scenario 3: safe actions return safe', () => {
    expect(classifyAction('Click the Next button')).toBe('safe');
    expect(classifyAction('Fill in the username field')).toBe('safe');
    expect(classifyAction('Navigate to settings page')).toBe('safe');
    expect(classifyAction('Read the dashboard')).toBe('safe');
    expect(classifyAction('Save draft')).toBe('safe');
    expect(classifyAction('View user profile')).toBe('safe');
  });

  it('scenario 4: case insensitive matching', () => {
    expect(classifyAction('REMOVE ALL ITEMS')).toBe('destructive');
    expect(classifyAction('DELETE User')).toBe('destructive');
    expect(classifyAction('SEND Message')).toBe('outbound');
    expect(classifyAction('Publish Post')).toBe('outbound');
  });

  it('empty string returns safe', () => {
    expect(classifyAction('')).toBe('safe');
  });
});

describe('isBlocked', () => {
  it('returns true for destructive and outbound', () => {
    expect(isBlocked('destructive')).toBe(true);
    expect(isBlocked('outbound')).toBe(true);
  });

  it('returns false for safe', () => {
    expect(isBlocked('safe')).toBe(false);
  });
});

describe('makeBlockedAction', () => {
  it('builds a BlockedAction for destructive classification', () => {
    const action = makeBlockedAction('Delete the user record', 'destructive');
    expect(action.description).toBe('Delete the user record');
    expect(action.classification).toBe('destructive');
    expect(action.reason).toContain('destructive');
    expect(action.reason).toContain('data loss');
  });

  it('builds a BlockedAction for outbound classification', () => {
    const action = makeBlockedAction('Send welcome email', 'outbound');
    expect(action.classification).toBe('outbound');
    expect(action.reason).toContain('outbound');
  });
});
