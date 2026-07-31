import { describe, it, expect } from 'vitest';
import { compileSearch } from './search-compiler';
import { parseSearch } from './search-parser';

describe('search-compiler', () => {
  // from/to/cc compile to imapflow's HEADER form, not bare keys. These three
  // expectations were written against an older compiler shape and had been
  // failing since f63400c1. The header form is what ImapDriver.list actually
  // sends and what the search control matrix verifies end to end on both
  // GreenMail and Dovecot, so the test was stale, not the compiler.
  it('from', () =>
    expect(compileSearch({ op: 'from', value: 'a' }).imapCriteria).toEqual({
      header: { from: 'a' },
    }));
  it('to', () =>
    expect(compileSearch({ op: 'to', value: 'a' }).imapCriteria).toEqual({ header: { to: 'a' } }));
  it('cc', () =>
    expect(compileSearch({ op: 'cc', value: 'a' }).imapCriteria).toEqual({ header: { cc: 'a' } }));
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
    expect(() => compileSearch({ op: 'unknown', operator: 'bcc', value: 'a' } as any)).toThrow(/Unsupported operator: bcc/);
  });

  it('completeness guard', () => {
    const allOps = ['from', 'to', 'cc', 'subject', 'label', 'in', 'after', 'before', 'is', 'has', 'text', 'unknown', 'AND', 'OR', 'NOT'];
    for (const op of allOps) {
      const node = { op, value: 'inbox', operator: 'test', date: '2026-07-28', children: [], child: { op: 'text', value: 'a' } } as any;
      expect(() => compileSearch(node)).not.toThrow(/Unhandled AST node op/);
    }
  });

  it('parser -> compiler contract', () => {
    const query = 'from:alice subject:hello is:unread -label:work (to:bob OR has:attachment) "some text"';
    const ast = parseSearch(query);
    expect(ast).toBeDefined();
    expect(() => compileSearch(ast)).not.toThrow();
  });
});
