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

describe('whole-word matching', () => {
  it('does not match a keyword inside a longer word', () => {
    expect(classifyAction('Type the postcode')).toBe('safe');
    expect(classifyAction('Enter the sender name')).toBe('safe');
    expect(classifyAction('Open the dropdown')).toBe('safe');
    expect(classifyAction('Read the resetting guide heading')).toBe('safe');
    expect(classifyAction('Select a payment method')).toBe('safe');
    expect(classifyAction('Click Messages tab count')).toBe('outbound'); // "Messages" is a real word match
  });

  it('matches inflections, camelCase and snake_case', () => {
    expect(classifyAction('Deleting the account')).toBe('destructive');
    expect(classifyAction('Archived items')).toBe('destructive');
    expect(classifyAction('Sent notifications')).toBe('outbound');
    expect(classifyAction('Click removeButton')).toBe('destructive');
    expect(classifyAction('press delete_account')).toBe('destructive');
    expect(classifyAction('Posting a comment')).toBe('outbound');
  });

  it('keeps multi-word phrases together', () => {
    expect(classifyAction('Clear all filters')).toBe('destructive');
    expect(classifyAction('Clear the search box')).toBe('safe');
  });
});

describe('target role and accessible name', () => {
  it('filling a text field is safe whatever the description says', () => {
    expect(classifyAction('Type the message to send in the postcode box', { role: 'textbox', name: 'Postcode', tag: 'input', type: 'text' })).toBe('safe');
    expect(classifyAction('Delete the old value then type', { role: 'textbox', name: 'Email', tag: 'input', type: 'email' })).toBe('safe');
  });

  it('an activating control is judged by its own name', () => {
    expect(classifyAction('Click the button', { role: 'button', name: 'Delete account', tag: 'button' })).toBe('destructive');
    expect(classifyAction('Click the button', { role: 'button', name: 'Send invite', tag: 'button' })).toBe('outbound');
    expect(classifyAction('Delete everything now', { role: 'button', name: 'Next', tag: 'button' })).toBe('safe');
    expect(classifyAction('Go on', { role: 'link', name: 'Remove item', tag: 'a' })).toBe('destructive');
    expect(classifyAction('Go on', { role: 'button', name: 'Pay now', tag: 'input', type: 'submit' })).toBe('outbound');
    expect(classifyAction('Go on', { role: 'button', name: 'Save', tag: 'input', type: 'submit' })).toBe('safe');
  });

  it('a control with no name falls back to the description', () => {
    expect(classifyAction('Delete the record', { role: 'button', name: '', tag: 'button' })).toBe('destructive');
    expect(classifyAction('Open menu', { role: 'button', name: '', tag: 'button' })).toBe('safe');
  });

  it('an unknown element falls back to word matching on the description', () => {
    expect(classifyAction('Delete the record', { tag: 'div', role: '' })).toBe('destructive');
  });
});

describe('project policy', () => {
  it('deny blocks as destructive, allow wins over the built-in lists', () => {
    expect(classifyAction('Click Launch', { role: 'button', name: 'Launch rocket', tag: 'button' }, { deny: ['launch'] })).toBe('destructive');
    expect(classifyAction('Click', { role: 'button', name: 'Send test', tag: 'button' }, { allow: ['send test'] })).toBe('safe');
    expect(classifyAction('Click', { role: 'button', name: 'Send test email', tag: 'button' }, { allow: ['send test'] })).toBe('safe');
    expect(classifyAction('Click', { role: 'button', name: 'Send invite', tag: 'button' }, { allow: ['send test'] })).toBe('outbound');
  });

  it('allowOutbound lets outbound through and never destructive', () => {
    expect(isBlocked('outbound', { allowOutbound: true })).toBe(false);
    expect(isBlocked('outbound', {})).toBe(true);
    expect(isBlocked('destructive', { allowOutbound: true })).toBe(true);
    expect(isBlocked('safe', { allowOutbound: false })).toBe(false);
  });
});
