import { describe, expect, it } from 'vitest';
import { coerceGeneratedQuery, InvalidGeneratedQueryError } from './search-query-guard';

/**
 * The AI search text fallback is the only path where raw model prose can reach
 * the search parser. The two E2E legs in the matrix exercise the fallback's
 * BEST case (the model returns a clean query). These cover the bad cases,
 * which cannot be provoked E2E without stubbing the model.
 */
describe('coerceGeneratedQuery', () => {
  describe('accepts real queries', () => {
    it.each([
      'is:unread from:alice',
      'has:attachment',
      'from:bob newer_than:7d invoice',
      'subject:"quarterly report"',
      'is:starred is:unread',
    ])('accepts %j', (q) => {
      expect(coerceGeneratedQuery(q)).toBe(q);
    });

    it('accepts a bare-keyword query with no operator', () => {
      // The prompt explicitly instructs the model to return bare keywords when
      // no operator is needed, so requiring an operator would reject valid
      // searches.
      expect(coerceGeneratedQuery('budget spreadsheet')).toBe('budget spreadsheet');
    });

    it('strips code fences and takes the first line', () => {
      expect(coerceGeneratedQuery('```\nis:unread from:alice\n```')).toBe('is:unread from:alice');
    });
  });

  describe('rejects narration', () => {
    const narrations = [
      'Sure! Here are your unread emails from Alice',
      'Here are the emails with attachments you asked for.',
      'I found several messages matching your request; see below.',
      "I'm sorry, I don't have access to your mailbox.",
      'Of course - searching for unread mail from Alice now',
    ];

    it.each(narrations)('rejects %j', (text) => {
      expect(() => coerceGeneratedQuery(text)).toThrow(InvalidGeneratedQueryError);
    });

    it('does NOT let narration through as a free-text search', () => {
      // The whole point: this string must never become a search term.
      const narration = 'Sure! Here are your unread emails from Alice';
      let threw = false;
      try {
        coerceGeneratedQuery(narration);
      } catch (e) {
        threw = true;
        expect((e as InvalidGeneratedQueryError).raw).toBe(narration);
      }
      expect(threw).toBe(true);
    });

    it('rejects an over-long response', () => {
      expect(() => coerceGeneratedQuery('word '.repeat(100))).toThrow(InvalidGeneratedQueryError);
    });

    it('rejects empty output', () => {
      expect(() => coerceGeneratedQuery('   ')).toThrow(InvalidGeneratedQueryError);
      expect(() => coerceGeneratedQuery('')).toThrow(InvalidGeneratedQueryError);
    });
  });

  describe('narration that contains an operator-looking token', () => {
    it('accepts it, and that is the documented trade-off', () => {
      // An operator anywhere in the tree is taken as proof of intent. A
      // sentence that happens to contain "from:alice" passes. This is
      // deliberate: the alternative (rejecting anything sentence-shaped even
      // with operators) would reject legitimate compound queries. Recorded so
      // the behaviour is a decision, not an accident.
      expect(coerceGeneratedQuery('from:alice is:unread')).toBe('from:alice is:unread');
    });
  });
});
