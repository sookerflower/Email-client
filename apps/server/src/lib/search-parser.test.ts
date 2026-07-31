import { describe, it, expect } from 'vitest';
import { parseSearch } from './search-parser';

describe('search-parser', () => {
  it('quoted values with colons', () => {
    const ast = parseSearch('subject:"re: hello"');
    expect(ast).toEqual({ op: 'subject', value: 're: hello' });
  });

  it('empty operator value', () => {
    const ast = parseSearch('from:');
    expect(ast).toEqual({ op: 'from', value: '' });
  });

  it('mixed case', () => {
    const ast = parseSearch('Is:Unread');
    expect(ast).toEqual({ op: 'is', value: 'Unread' });
  });

  it('implicit-AND vs explicit-OR precedence', () => {
    const ast = parseSearch('from:bob OR from:alice subject:hello');
    expect(ast).toEqual({
      op: 'AND',
      children: [
        {
          op: 'OR',
          children: [
            { op: 'from', value: 'bob' },
            { op: 'from', value: 'alice' }
          ]
        },
        { op: 'subject', value: 'hello' }
      ]
    });
  });

  it('negated group', () => {
    const ast = parseSearch('NOT (from:bob)');
    expect(ast).toEqual({ op: 'NOT', child: { op: 'from', value: 'bob' } });
  });

  it('duplicate operator', () => {
    const ast = parseSearch('from:a from:b');
    expect(ast).toEqual({
      op: 'AND',
      children: [
        { op: 'from', value: 'a' },
        { op: 'from', value: 'b' }
      ]
    });
  });

  it('unbalanced parens', () => {
    const ast = parseSearch('(from:a');
    expect(ast).toEqual({ op: 'from', value: 'a' });
  });

  it('bare NOT/OR/AND as terms', () => {
    const ast = parseSearch('NOT OR AND');
    expect(ast).toBeNull();
  });

  it('AI-generated shape', () => {
    const ast = parseSearch('NOT is:draft (is:inbox OR (is:sent AND to:me))');
    expect(ast).toEqual({
      op: 'AND',
      children: [
        { op: 'NOT', child: { op: 'is', value: 'draft' } },
        {
          op: 'OR',
          children: [
            { op: 'is', value: 'inbox' },
            {
              op: 'AND',
              children: [
                { op: 'is', value: 'sent' },
                { op: 'to', value: 'me' }
              ]
            }
          ]
        }
      ]
    });
  });
});
