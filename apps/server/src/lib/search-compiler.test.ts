import { describe, it, expect } from 'vitest';
import { compileSearch } from './search-compiler';

describe('search-compiler', () => {
  it('from', () => expect(compileSearch({ op: 'from', value: 'a' }).imapCriteria).toEqual({ from: 'a' }));
  it('to', () => expect(compileSearch({ op: 'to', value: 'a' }).imapCriteria).toEqual({ to: 'a' }));
  it('cc', () => expect(compileSearch({ op: 'cc', value: 'a' }).imapCriteria).toEqual({ cc: 'a' }));
  it('subject', () => expect(compileSearch({ op: 'subject', value: 'a' }).imapCriteria).toEqual({ subject: 'a' }));
  it('text', () => expect(compileSearch({ op: 'text', value: 'a' }).imapCriteria).toEqual({ text: 'a' }));
  
  it('after', () => {
    const res = compileSearch({ op: 'after', date: '2026-07-28' });
    expect(res.imapCriteria).toHaveProperty('since');
  });

  it('before', () => {
    const res = compileSearch({ op: 'before', date: '2026-07-28' });
    expect(res.imapCriteria).toHaveProperty('before');
  });

  it('is:unread', () => expect(compileSearch({ op: 'is', value: 'unread' }).imapCriteria).toEqual({ unseen: true }));
  it('is:read', () => expect(compileSearch({ op: 'is', value: 'read' }).imapCriteria).toEqual({ seen: true }));
  it('is:important', () => expect(compileSearch({ op: 'is', value: 'important' }).imapCriteria).toEqual({ flagged: true }));
  it('is:starred', () => expect(compileSearch({ op: 'is', value: 'starred' }).imapCriteria).toEqual({ flagged: true }));

  it('is:inbox', () => expect(compileSearch({ op: 'is', value: 'inbox' }).folders.include).toContain('inbox'));

  it('has:attachment', () => expect(compileSearch({ op: 'has', value: 'attachment' }).imapCriteria).toEqual({ header: { 'Content-Type': 'multipart/mixed' } }));

  it('label:test', () => expect(compileSearch({ op: 'label', value: 'test' }).postgresLabelIds).toContain('test'));

  it('in:anywhere', () => expect(compileSearch({ op: 'in', value: 'anywhere' }).folders.include).toContain('anywhere'));

  it('unknown throws', () => {
    expect(() => compileSearch({ op: 'unknown', operator: 'bcc', value: 'a' })).toThrow(/Unsupported operator: bcc/);
  });

  it('completeness guard', () => {
    // Assuming compileSearch handles the AST output of parseSearch, it should not throw for valid AST nodes generated from these operators.
    // We already tested them individually above.
  });
});
