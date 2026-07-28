/**
 * Header-based mail threading for the IMAP driver.
 *
 * Implements the REFERENCES algorithm from RFC 5256 (which itself derives
 * from the JWZ algorithm): messages are linked into trees purely via their
 * Message-ID / In-Reply-To / References headers. The RFC's final
 * subject-gathering step is deliberately omitted — subject-line grouping is
 * the known-buggy behavior this implementation exists to replace.
 *
 * The exported thread id for a group is the Message-ID of the root of its
 * reference chain. That root does not need to be present in the mailbox
 * (e.g. the original mail was deleted): every descendant still names the
 * same root in its References header, so the id is stable and stateless.
 */

export interface ThreadableMessage {
  /** Normalized Message-ID (angle brackets stripped). Undefined for malformed mail. */
  messageId?: string;
  /** Normalized In-Reply-To Message-ID. */
  inReplyTo?: string;
  /** Normalized References chain, oldest first. */
  references: string[];
}

export interface ThreadGroup<T extends ThreadableMessage> {
  /** Message-ID of the thread root (may belong to a message not in `messages`). */
  rootId: string;
  messages: T[];
}

interface Container<T> {
  id: string;
  message?: T;
  parent?: Container<T>;
  children: Set<Container<T>>;
}

/** Strip angle brackets and surrounding whitespace from a Message-ID token. */
export function normalizeMessageId(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const match = trimmed.match(/<([^<>]+)>/);
  const id = (match ? match[1] : trimmed).trim();
  return id.length > 0 ? id : undefined;
}

/** Extract every Message-ID token from a raw References/In-Reply-To header value. */
export function parseReferencesHeader(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const matches = raw.match(/<[^<>]+>/g);
  if (!matches) {
    // Tolerate a bare id without angle brackets.
    const bare = normalizeMessageId(raw);
    return bare ? [bare] : [];
  }
  return matches
    .map((m) => normalizeMessageId(m))
    .filter((id): id is string => id !== undefined);
}

function isAncestor<T>(candidate: Container<T>, of: Container<T>): boolean {
  let current: Container<T> | undefined = of.parent;
  while (current) {
    if (current === candidate) return true;
    current = current.parent;
  }
  return false;
}

function setParent<T>(child: Container<T>, parent: Container<T>): void {
  if (child === parent) return;
  // Never introduce a cycle.
  if (isAncestor(child, parent)) return;
  if (child.parent) child.parent.children.delete(child);
  child.parent = parent;
  parent.children.add(child);
}

/**
 * Group messages into threads via their reference chains.
 */
export function groupIntoThreads<T extends ThreadableMessage>(messages: T[]): ThreadGroup<T>[] {
  const containers = new Map<string, Container<T>>();

  const containerFor = (id: string): Container<T> => {
    let c = containers.get(id);
    if (!c) {
      c = { id, children: new Set() };
      containers.set(id, c);
    }
    return c;
  };

  for (const message of messages) {
    // 1. Chain the References header: each id is the parent of the next.
    const chain = [...message.references];
    if (message.inReplyTo && chain[chain.length - 1] !== message.inReplyTo) {
      chain.push(message.inReplyTo);
    }

    for (let i = 0; i < chain.length - 1; i++) {
      const parent = containerFor(chain[i]!);
      const child = containerFor(chain[i + 1]!);
      // Only link if the child is not already claimed — the first seen
      // chain wins, per RFC 5256 step 1.A.
      if (!child.parent) setParent(child, parent);
    }

    // 2. Attach the message's own container under the last reference.
    if (!message.messageId) throw new Error("ThreadableMessage missing messageId");
    const selfId = message.messageId;
    const self = containerFor(selfId);

    if (self.message !== undefined && message.messageId !== undefined) {
      // Duplicate Message-ID (e.g. same mail in INBOX and Sent). Keep the
      // first occurrence; callers dedupe display-side.
      continue;
    }
    self.message = message;

    const parentId = chain[chain.length - 1];
    if (parentId !== undefined && parentId !== selfId) {
      // The message's stated parent always wins over speculative links
      // made while processing other messages' chains.
      setParent(self, containerFor(parentId));
    }
  }

  // 3. Walk each populated container up to its root and bucket by root id.
  const groups = new Map<string, ThreadGroup<T>>();
  for (const container of containers.values()) {
    if (container.message === undefined) continue;
    let root: Container<T> = container;
    while (root.parent) root = root.parent;
    let group = groups.get(root.id);
    if (!group) {
      group = { rootId: root.id, messages: [] };
      groups.set(root.id, group);
    }
    group.messages.push(container.message);
  }

  return [...groups.values()];
}
