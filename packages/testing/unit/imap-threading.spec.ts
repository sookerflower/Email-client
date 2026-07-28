import { describe, expect, it } from 'vitest';
import {
  groupIntoThreads,
  normalizeMessageId,
  parseReferencesHeader,
  type ThreadableMessage,
} from '../../apps/server/src/lib/driver/imap-threading';

const msg = (
  messageId: string | undefined,
  references: string[] = [],
  inReplyTo?: string,
): ThreadableMessage & { key: string } => ({
  key: messageId ?? 'anon',
  messageId,
  inReplyTo,
  references,
});

const rootOf = (groups: ReturnType<typeof groupIntoThreads<ReturnType<typeof msg>>>, key: string) =>
  groups.find((g) => g.messages.some((m) => m.key === key));

describe('normalizeMessageId', () => {
  it('strips angle brackets and whitespace', () => {
    expect(normalizeMessageId('  <abc@example.com>  ')).toBe('abc@example.com');
  });

  it('accepts bare ids without brackets', () => {
    expect(normalizeMessageId('abc@example.com')).toBe('abc@example.com');
  });

  it('returns undefined for empty/missing values', () => {
    expect(normalizeMessageId(undefined)).toBeUndefined();
    expect(normalizeMessageId('')).toBeUndefined();
    expect(normalizeMessageId('   ')).toBeUndefined();
  });
});

describe('parseReferencesHeader', () => {
  it('extracts every bracketed id, tolerating folded whitespace', () => {
    expect(parseReferencesHeader('<a@x>\r\n\t <b@y>   <c@z>')).toEqual(['a@x', 'b@y', 'c@z']);
  });

  it('tolerates a bare id', () => {
    expect(parseReferencesHeader('a@x')).toEqual(['a@x']);
  });

  it('returns empty for missing header', () => {
    expect(parseReferencesHeader(undefined)).toEqual([]);
    expect(parseReferencesHeader('')).toEqual([]);
  });
});

describe('groupIntoThreads', () => {
  it('groups a linear reply chain into one thread rooted at the first message', () => {
    const groups = groupIntoThreads([
      msg('a@x'),
      msg('b@x', ['a@x'], 'a@x'),
      msg('c@x', ['a@x', 'b@x'], 'b@x'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rootId).toBe('a@x');
    expect(groups[0]!.messages).toHaveLength(3);
  });

  it('keeps unrelated messages in separate threads (no subject grouping)', () => {
    // Same subject would have merged these under AxMail's buggy logic;
    // header-based threading must keep them apart.
    const groups = groupIntoThreads([msg('a@x'), msg('b@x')]);
    expect(groups).toHaveLength(2);
  });

  it('threads a reply whose root is absent from the mailbox (split thread)', () => {
    // The original a@x was deleted/not fetched; both replies still reference it.
    const groups = groupIntoThreads([
      msg('b@x', ['a@x'], 'a@x'),
      msg('c@x', ['a@x', 'b@x'], 'b@x'),
    ]);
    expect(groups).toHaveLength(1);
    // Thread id stays the phantom root — stable no matter which members exist.
    expect(groups[0]!.rootId).toBe('a@x');
  });

  it('merges two branches of the same thread fetched out of order', () => {
    // Two people replied to a@x independently; messages arrive shuffled.
    const groups = groupIntoThreads([
      msg('d@x', ['a@x', 'c@x'], 'c@x'),
      msg('b@x', ['a@x'], 'a@x'),
      msg('a@x'),
      msg('c@x', ['a@x'], 'a@x'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rootId).toBe('a@x');
    expect(groups[0]!.messages).toHaveLength(4);
  });

  it('joins sibling replies into one thread even when the connecting parent is phantom', () => {
    // b and c only share the phantom parent a@x.
    const groups = groupIntoThreads([msg('b@x', ['a@x']), msg('c@x', ['a@x'])]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rootId).toBe('a@x');
  });

  it('uses In-Reply-To when References is missing', () => {
    const groups = groupIntoThreads([msg('a@x'), msg('b@x', [], 'a@x')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rootId).toBe('a@x');
  });

  it('survives reference cycles without infinite loops', () => {
    // Malicious/broken mail: a references b, b references a.
    const groups = groupIntoThreads([msg('a@x', ['b@x'], 'b@x'), msg('b@x', ['a@x'], 'a@x')]);
    const total = groups.reduce((n, g) => n + g.messages.length, 0);
    expect(total).toBe(2);
    // Both must land in the same thread — whichever direction won.
    expect(groups).toHaveLength(1);
  });

  it('survives self-referencing messages', () => {
    const groups = groupIntoThreads([msg('a@x', ['a@x'], 'a@x')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rootId).toBe('a@x');
  });

  it('treats messages with unique synthetic Message-IDs as singleton threads', () => {
    const groups = groupIntoThreads([msg('synthetic-1'), msg('synthetic-2')]);
    expect(groups).toHaveLength(2);
  });

  it('deduplicates the same Message-ID seen twice (e.g. INBOX + Sent copies)', () => {
    const groups = groupIntoThreads([msg('a@x'), msg('a@x')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.messages).toHaveLength(1);
  });

  it('does not let a forged chain re-parent an already-claimed message', () => {
    // c claims parent b (via its own headers, processed first);
    // a later message's References suggesting c is a child of z must not win.
    const groups = groupIntoThreads([
      msg('b@x'),
      msg('c@x', ['b@x'], 'b@x'),
      msg('e@x', ['z@x', 'c@x'], 'c@x'),
    ]);
    const cGroup = rootOf(groups, 'c@x');
    expect(cGroup!.rootId).toBe('b@x');
    // e follows its real parent c, so it belongs to b's thread too.
    expect(rootOf(groups, 'e@x')!.rootId).toBe('b@x');
  });

  it('handles a deep chain without stack issues', () => {
    const chain: ReturnType<typeof msg>[] = [];
    const refs: string[] = [];
    for (let i = 0; i < 500; i++) {
      const id = `m${i}@x`;
      chain.push(msg(id, [...refs], refs[refs.length - 1]));
      refs.push(id);
    }
    const groups = groupIntoThreads(chain);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rootId).toBe('m0@x');
    expect(groups[0]!.messages).toHaveLength(500);
  });
});
