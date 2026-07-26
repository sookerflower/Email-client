import {
  groupIntoThreads,
  normalizeMessageId,
  parseReferencesHeader,
  type ThreadableMessage,
} from './imap-threading';
import type {
  IGetThreadResponse,
  MailManager,
  ManagerConfig,
  ImapSmtpAuthConfig,
  ParsedDraft,
} from './types';
import type { IOutgoingMessage, Label, ParsedMessage, DeleteAllSpamResponse } from '../../types';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { CreateDraftData } from '../schemas';
import { StandardizedError } from './standardized-error';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

/**
 * Minimal key/value contract for the user-label registry. Backed by workerd
 * KV in the deployed path and by a file/in-memory store in the Node sidecar,
 * so the driver itself stays runtime-agnostic (no `cloudflare:workers` import).
 */
export interface LabelStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

const createMemoryLabelStore = (): LabelStore => {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
};

/**
 * MailManager implementation for arbitrary IMAP/SMTP servers.
 *
 * Transport logic (connection handling, folder discovery, append/move/flag
 * operations, raw-MIME send with explicit envelope) is ported from AxMail's
 * production ImapMailboxClient / SmtpMailSender. Thread grouping is NOT
 * ported — it is computed from Message-ID / In-Reply-To / References headers
 * via ./imap-threading (RFC 5256), because AxMail's own grouping is buggy.
 *
 * Id scheme (IMAP has no provider-side thread or global message ids):
 * - message id: `<b64url(folder)>.<uidValidity>.<uid>`  (3 dot-separated parts)
 * - thread id:  `<b64url(root Message-ID)>`             (no dots)
 * Message ids are only valid while the folder's UIDVALIDITY is unchanged;
 * stale ids fail loudly rather than acting on the wrong mail.
 */

type FolderKind = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

const FOLDER_SPECIAL_USE: Record<FolderKind, string | null> = {
  inbox: null,
  sent: '\\Sent',
  drafts: '\\Drafts',
  trash: '\\Trash',
  junk: '\\Junk',
  archive: '\\Archive',
};

const FOLDER_NAME_FALLBACKS: Record<FolderKind, string[]> = {
  inbox: ['INBOX'],
  sent: ['Sent', 'Sent Items', 'Sent Messages'],
  drafts: ['Drafts'],
  trash: ['Trash', 'Deleted Items', 'Bin', 'Deleted Messages'],
  junk: ['Junk', 'Spam', 'Junk E-mail'],
  archive: ['Archive', 'Archives', 'All Mail'],
};

/** Folders searched when resolving the members of a thread. */
const THREAD_MEMBER_FOLDERS: FolderKind[] = ['inbox', 'sent', 'archive', 'drafts'];

const SYSTEM_LABEL_IDS = new Set([
  'INBOX',
  'SENT',
  'DRAFT',
  'DRAFTS',
  'SPAM',
  'TRASH',
  'ARCHIVE',
  'STARRED',
  'UNREAD',
  'IMPORTANT',
]);

/** Prefix for IMAP keywords backing Zero user labels. */
const KEYWORD_PREFIX = '$zl_';

interface RegistryLabel {
  id: string; // the IMAP keyword, e.g. `$zl_receipts`
  name: string;
  color?: { backgroundColor: string; textColor: string };
}

interface MessageMeta extends ThreadableMessage {
  uid: number;
  date: Date;
  subject: string;
  from: string;
  unread: boolean;
  flags: Set<string>;
}

const toB64Url = (value: string) => Buffer.from(value, 'utf-8').toString('base64url');
const fromB64Url = (value: string) => Buffer.from(value, 'base64url').toString('utf-8');

const encodeMessageId = (folder: string, uidValidity: bigint | number, uid: number) =>
  `${toB64Url(folder)}.${uidValidity}.${uid}`;

const decodeMessageId = (id: string): { folder: string; uidValidity: string; uid: number } | null => {
  const parts = id.split('.');
  if (parts.length !== 3) return null;
  const uid = Number(parts[2]);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  try {
    return { folder: fromB64Url(parts[0]!), uidValidity: parts[1]!, uid };
  } catch {
    return null;
  }
};

const encodeThreadId = (rootMessageId: string) => toB64Url(rootMessageId);
const decodeThreadId = (id: string) => fromB64Url(id.startsWith('thread:') ? id.substring(7) : id);

const addressList = (input: AddressObject | AddressObject[] | undefined) => {
  if (!input) return [] as { name?: string; email: string }[];
  const items = Array.isArray(input) ? input : [input];
  return items.flatMap((item) =>
    item.value.map((a) => ({ name: a.name || undefined, email: a.address ?? '' })),
  );
};

const formatRecipients = (recipients: { name?: string; email: string }[] | undefined) =>
  (recipients ?? []).map((r) => (r.name ? `"${r.name}" <${r.email}>` : r.email));

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

export class ImapSmtpMailManager implements MailManager {
  private readonly imapAuth: ImapSmtpAuthConfig;
  private readonly labelStore: LabelStore;
  private client: ImapFlow | undefined;
  private folderCache: Partial<Record<FolderKind, string | undefined>> = {};

  constructor(
    public config: ManagerConfig,
    opts: { labelStore?: LabelStore } = {},
  ) {
    if (!config.auth?.imap) {
      throw new Error(
        'ImapSmtpMailManager requires config.auth.imap (host/port/username/password)',
      );
    }
    if (!config.auth.imap.password) {
      throw new Error('ImapSmtpMailManager requires a decrypted password in config.auth.imap');
    }
    this.imapAuth = config.auth.imap;
    this.labelStore = opts.labelStore ?? createMemoryLabelStore();
  }

  // ------------------------------------------------------------------
  // Connection + shared helpers
  // ------------------------------------------------------------------

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    this.client = new ImapFlow({
      host: this.imapAuth.imapHost,
      port: this.imapAuth.imapPort,
      secure: this.imapAuth.imapSecure,
      auth: { user: this.imapAuth.username, pass: this.imapAuth.password },
      logger: false,
      tls: this.imapAuth.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
    });
    this.client.on('error', (err) => {
      console.error('[ImapSmtpMailManager] imap connection error:', (err as Error)?.message);
    });
    await this.client.connect();
    return this.client;
  }

  /**
   * Verify both transports with the stored credentials: IMAP login + folder
   * list (AxMail's testConnection) plus SMTP connect/auth via nodemailer's
   * verify(). Returns a reason string instead of throwing so the add-account
   * form can surface it directly.
   */
  public async testConnection(): Promise<{ connected: boolean; reason?: string }> {
    try {
      const client = await this.connect();
      await client.list();
    } catch (error) {
      return { connected: false, reason: `IMAP: ${(error as Error).message}` };
    }
    try {
      const transporter = nodemailer.createTransport({
        host: this.imapAuth.smtpHost,
        port: this.imapAuth.smtpPort,
        secure: this.imapAuth.smtpSecure,
        auth: { user: this.imapAuth.username, pass: this.imapAuth.password },
        tls: this.imapAuth.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
      });
      await transporter.verify();
    } catch (error) {
      return { connected: false, reason: `SMTP: ${(error as Error).message}` };
    }
    return { connected: true };
  }

  /** Close the IMAP connection. Safe to call multiple times. */
  public async dispose(): Promise<void> {
    if (!this.client) return;
    await this.client.logout().catch(() => undefined);
    this.client = undefined;
  }

  private async withErrorHandler<T>(
    operation: string,
    fn: () => Promise<T>,
    context?: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error(`[IMAP Driver Error] Operation: ${operation}`, {
        error: error.message,
        code: error.code,
        context,
      });
      throw new StandardizedError(error, operation, context);
    }
  }

  /**
   * Ported from AxMail's discoverFolder: special-use flags first, then exact
   * name match, then suffix match (handles `INBOX.Sent`-style namespaces).
   */
  private async resolveFolder(kind: FolderKind, createIfMissing = false): Promise<string | undefined> {
    if (kind === 'inbox') return 'INBOX';
    if (this.folderCache[kind]) return this.folderCache[kind];

    const client = await this.connect();
    const folders = await client.list();

    const specialUse = FOLDER_SPECIAL_USE[kind];
    let found = specialUse
      ? folders.find((f) => f.specialUse === specialUse || f.flags?.has(specialUse))
      : undefined;

    if (!found) {
      const fallbacks = new Set(FOLDER_NAME_FALLBACKS[kind].map((n) => n.toLowerCase()));
      found =
        folders.find((f) => fallbacks.has(f.path.toLowerCase())) ??
        folders.find((f) => {
          const segments = f.path.toLowerCase().split(/[./]/);
          return fallbacks.has(segments[segments.length - 1] ?? '');
        });
    }

    let path = found?.path;
    if (!path && createIfMissing) {
      path = FOLDER_NAME_FALLBACKS[kind][0];
      try {
        await client.mailboxCreate(path!);
      } catch {
        // Already exists or cannot create — mailboxOpen will surface real errors.
      }
    }

    this.folderCache[kind] = path;
    return path;
  }

  private folderKindFromZeroName(folder: string): FolderKind {
    switch (folder.toLowerCase()) {
      case 'sent':
        return 'sent';
      case 'draft':
      case 'drafts':
        return 'drafts';
      case 'trash':
      case 'bin':
        return 'trash';
      case 'spam':
      case 'junk':
        return 'junk';
      case 'archive':
        return 'archive';
      default:
        return 'inbox';
    }
  }

  // ------------------------------------------------------------------
  // Label registry (user labels = IMAP keywords + KV-backed name/color)
  // ------------------------------------------------------------------

  private registryKey() {
    return `imap-labels:${this.config.auth.userId}:${this.config.auth.email}`;
  }

  private async loadRegistry(): Promise<RegistryLabel[]> {
    try {
      const raw = await this.labelStore.get(this.registryKey());
      return raw ? (JSON.parse(raw) as RegistryLabel[]) : [];
    } catch {
      return [];
    }
  }

  private async saveRegistry(labels: RegistryLabel[]): Promise<void> {
    await this.labelStore.put(this.registryKey(), JSON.stringify(labels));
  }

  private async resolveKeyword(labelNameOrId: string): Promise<string | undefined> {
    if (labelNameOrId.startsWith(KEYWORD_PREFIX)) return labelNameOrId;
    const registry = await this.loadRegistry();
    return registry.find(
      (l) => l.name.toLowerCase() === labelNameOrId.toLowerCase() || l.id === labelNameOrId,
    )?.id;
  }

  // ------------------------------------------------------------------
  // list / get
  // ------------------------------------------------------------------

  /**
   * Folder state for the UIDVALIDITY guard / incremental sync (Phase 6).
   * Uses STATUS so the connection's selected mailbox is untouched.
   */
  public getFolderState(folder: string) {
    return this.withErrorHandler(
      'getFolderState',
      async () => {
        const path = await this.resolveFolder(this.folderKindFromZeroName(folder));
        if (!path) return null;
        const client = await this.connect();
        const status = await client.status(path, {
          uidValidity: true,
          uidNext: true,
          highestModseq: true,
          messages: true,
        });
        return {
          folder,
          path,
          uidValidity: status.uidValidity != null ? Number(status.uidValidity) : null,
          uidNext: status.uidNext != null ? Number(status.uidNext) : null,
          highestModseq: status.highestModseq != null ? String(status.highestModseq) : null,
          messages: status.messages ?? null,
        };
      },
      { folder, email: this.config.auth.email },
    );
  }

  public list(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string | number;
  }) {
    const { folder, query, maxResults = 50, pageToken } = params;
    return this.withErrorHandler(
      'list',
      async () => {
        const path = await this.resolveFolder(this.folderKindFromZeroName(folder));
        if (!path) return { threads: [], nextPageToken: null };

        const client = await this.connect();
        const mailbox = await client.mailboxOpen(path);
        if (mailbox.exists === 0) return { threads: [], nextPageToken: null };

        const offset = Number(pageToken ?? 0) || 0;
        const metas: MessageMeta[] = [];
        let nextPageToken: string | null = null;

        const fetchQuery = {
          envelope: true,
          flags: true,
          uid: true,
          headers: ['references', 'in-reply-to', 'message-id'],
        };

        if (query) {
          // Basic full-text search; refine per-field later if needed.
          const uids = ((await client.search({ text: query }, { uid: true })) || []).sort(
            (a, b) => a - b,
          );
          const windowEnd = uids.length - offset;
          if (windowEnd <= 0) return { threads: [], nextPageToken: null };
          const window = uids.slice(Math.max(0, windowEnd - maxResults), windowEnd);
          if (window.length === 0) return { threads: [], nextPageToken: null };
          for await (const item of client.fetch(window.join(','), fetchQuery, { uid: true })) {
            metas.push(this.toMessageMeta(item));
          }
          nextPageToken = windowEnd - window.length > 0 ? String(offset + window.length) : null;
        } else {
          const end = mailbox.exists - offset;
          if (end < 1) return { threads: [], nextPageToken: null };
          const start = Math.max(1, end - maxResults + 1);
          for await (const item of client.fetch(`${start}:${end}`, fetchQuery)) {
            metas.push(this.toMessageMeta(item));
          }
          nextPageToken = start > 1 ? String(offset + (end - start + 1)) : null;
        }

        const groups = groupIntoThreads(metas);
        // Newest thread first, by the newest message inside each thread.
        const newestOf = (g: { messages: MessageMeta[] }) =>
          Math.max(...g.messages.map((m) => m.date.getTime()));
        groups.sort((a, b) => newestOf(b) - newestOf(a));

        return {
          threads: groups.map((g) => {
            const newest = [...g.messages].sort(
              (a, b) => b.date.getTime() - a.date.getTime(),
            )[0]!;
            return {
              id: encodeThreadId(g.rootId),
              historyId: null,
              $raw: {
                folder: path,
                subject: newest.subject,
                from: newest.from,
                date: newest.date.toISOString(),
                unread: g.messages.some((m) => m.unread),
                messageCount: g.messages.length,
                uids: g.messages.map((m) => m.uid),
              },
            };
          }),
          nextPageToken,
        };
      },
      { folder, query, maxResults, pageToken, email: this.config.auth.email },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toMessageMeta(item: any): MessageMeta {
    const headerText = item.headers ? item.headers.toString('utf-8') : '';
    const referencesRaw = headerText.match(/^references:([\s\S]*?)(?=^\S|Z)/im)?.[1] ?? '';
    const flags: Set<string> = item.flags ?? new Set<string>();
    return {
      uid: item.uid,
      messageId: normalizeMessageId(item.envelope?.messageId),
      inReplyTo: normalizeMessageId(item.envelope?.inReplyTo),
      references: parseReferencesHeader(referencesRaw),
      date: item.envelope?.date ?? new Date(0),
      subject: item.envelope?.subject ?? '',
      from: item.envelope?.from?.[0]?.address ?? '',
      unread: !flags.has('\\Seen'),
      flags,
    };
  }

  public get(id: string) {
    return this.withErrorHandler(
      'get',
      async () => {
        const rootId = decodeThreadId(id);
        const registry = await this.loadRegistry();
        const client = await this.connect();

        const messages: ParsedMessage[] = [];
        const seenMessageIds = new Set<string>();
        const labels = new Map<string, string>();

        for (const kind of THREAD_MEMBER_FOLDERS) {
          const path = await this.resolveFolder(kind);
          if (!path) continue;
          let mailbox;
          try {
            mailbox = await client.mailboxOpen(path);
          } catch (error) {
            // A missing/unselectable folder is fine to skip. A dead
            // connection is not: skipping every folder would fabricate an
            // empty thread ("No latest message") instead of surfacing the
            // failure to the worker's reconnect retry.
            if (!client.usable) throw error;
            continue;
          }
          if (mailbox.exists === 0) continue;

          const uids =
            (await client.search(
              {
                or: [
                  { header: { 'message-id': rootId } },
                  { header: { references: rootId } },
                  { header: { 'in-reply-to': rootId } },
                ],
              },
              { uid: true },
            )) || [];
          if (uids.length === 0) continue;

          for (const uid of uids) {
            const item = await client.fetchOne(String(uid), { source: true, flags: true, uid: true }, { uid: true });
            if (!item || !item.source) continue;
            const parsed = await simpleParser(item.source);
            const msgId = normalizeMessageId(parsed.messageId);
            if (msgId && seenMessageIds.has(msgId)) continue; // same mail in two folders
            if (msgId) seenMessageIds.add(msgId);

            const message = this.toParsedMessage(parsed, {
              folder: path,
              uid,
              uidValidity: mailbox.uidValidity,
              flags: item.flags ?? new Set<string>(),
              threadId: id,
              isDraftFolder: kind === 'drafts',
              registry,
            });
            message.tags.forEach((t) => labels.set(t.id, t.name));
            messages.push(message);
          }
        }

        messages.sort(
          (a, b) => new Date(a.receivedOn).getTime() - new Date(b.receivedOn).getTime(),
        );

        return {
          messages,
          latest: messages.findLast((m) => m.isDraft !== true),
          hasUnread: messages.some((m) => m.unread),
          totalReplies: messages.filter((m) => !m.isDraft).length,
          labels: [...labels.entries()].map(([labelId, name]) => ({ id: labelId, name })),
        } satisfies IGetThreadResponse;
      },
      { id, email: this.config.auth.email },
    );
  }

  private toParsedMessage(
    parsed: ParsedMail,
    meta: {
      folder: string;
      uid: number;
      uidValidity: bigint;
      flags: Set<string>;
      threadId: string;
      isDraftFolder: boolean;
      registry: RegistryLabel[];
    },
  ): ParsedMessage {
    const unread = !meta.flags.has('\\Seen');
    const tags: { id: string; name: string; type: string }[] = [];
    if (unread) tags.push({ id: 'UNREAD', name: 'UNREAD', type: 'system' });
    if (meta.flags.has('\\Flagged')) tags.push({ id: 'STARRED', name: 'STARRED', type: 'system' });
    for (const flag of meta.flags) {
      if (flag.startsWith(KEYWORD_PREFIX)) {
        const entry = meta.registry.find((l) => l.id === flag);
        tags.push({ id: flag, name: entry?.name ?? flag.slice(KEYWORD_PREFIX.length), type: 'user' });
      }
    }

    const html = typeof parsed.html === 'string' ? parsed.html : '';
    const text = parsed.text ?? '';
    const decodedBody = html || (text ? text.replace(/\n/g, '<br>') : '');
    const sender = addressList(parsed.from)[0] ?? { email: '' };
    const listUnsubscribe = parsed.headers.get('list-unsubscribe');

    return {
      id: encodeMessageId(meta.folder, meta.uidValidity, meta.uid),
      title: parsed.subject ?? '',
      subject: parsed.subject ?? '',
      tags,
      sender,
      to: addressList(parsed.to),
      cc: parsed.cc ? addressList(parsed.cc) : null,
      bcc: parsed.bcc ? addressList(parsed.bcc) : null,
      tls: this.imapAuth.imapSecure,
      listUnsubscribe: typeof listUnsubscribe === 'string' ? listUnsubscribe : undefined,
      receivedOn: (parsed.date ?? new Date()).toISOString(),
      unread,
      body: '',
      processedHtml: '',
      blobUrl: '',
      decodedBody,
      references: parsed.references
        ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]).join(' ')
        : undefined,
      inReplyTo: normalizeMessageId(parsed.inReplyTo),
      messageId: normalizeMessageId(parsed.messageId),
      threadId: meta.threadId,
      attachments: (parsed.attachments ?? []).map((a, index) => ({
        attachmentId: String(index),
        filename: a.filename ?? 'attachment',
        mimeType: a.contentType ?? 'application/octet-stream',
        size: a.size ?? a.content?.length ?? 0,
        body: '', // fetched on demand via getMessageAttachments/getAttachment
        headers: [],
      })),
      isDraft: meta.isDraftFolder || meta.flags.has('\\Draft') ? true : undefined,
    };
  }

  /** Resolve thread ids to per-folder UID sets by searching reference headers. */
  private async resolveThreadMembers(
    threadIds: string[],
    kinds: FolderKind[] = THREAD_MEMBER_FOLDERS,
  ): Promise<Map<string, number[]>> {
    const client = await this.connect();
    const byFolder = new Map<string, number[]>();
    const rootIds = threadIds.map((id) => decodeThreadId(id));

    for (const kind of kinds) {
      const path = await this.resolveFolder(kind);
      if (!path) continue;
      try {
        const mailbox = await client.mailboxOpen(path);
        if (mailbox.exists === 0) continue;
      } catch {
        continue;
      }
      const uids = new Set<number>();
      for (const rootId of rootIds) {
        const found =
          (await client.search(
            {
              or: [
                { header: { 'message-id': rootId } },
                { header: { references: rootId } },
                { header: { 'in-reply-to': rootId } },
              ],
            },
            { uid: true },
          )) || [];
        found.forEach((u) => uids.add(u));
      }
      if (uids.size > 0) byFolder.set(path, [...uids].sort((a, b) => a - b));
    }
    return byFolder;
  }

  // ------------------------------------------------------------------
  // Sending (raw MIME + explicit envelope, ported from AxMail SmtpMailSender)
  // ------------------------------------------------------------------

  /** Render the exact MIME bytes nodemailer would send, without sending. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async renderRawMime(mailOptions: Record<string, any>): Promise<{ raw: string; messageId?: string }> {
    const streamTransporter = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
    });
    const info = await streamTransporter.sendMail(mailOptions);
    return { raw: (info.message as Buffer).toString('utf-8'), messageId: info.messageId };
  }

  private async smtpSend(from: string, recipients: string[], raw: string): Promise<void> {
    const transporter = nodemailer.createTransport({
      host: this.imapAuth.smtpHost,
      port: this.imapAuth.smtpPort,
      secure: this.imapAuth.smtpSecure,
      auth: { user: this.imapAuth.username, pass: this.imapAuth.password },
      tls: this.imapAuth.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
    });
    await transporter.sendMail({ envelope: { from, to: recipients }, raw });
  }

  private async appendToSent(raw: string): Promise<void> {
    const sentPath = await this.resolveFolder('sent', true);
    if (!sentPath) {
      console.warn('[ImapSmtpMailManager] No Sent folder found; sent copy not stored');
      return;
    }
    const client = await this.connect();
    await client.append(sentPath, raw, ['\\Seen']);
  }

  private outgoingToMailOptions(data: IOutgoingMessage) {
    const headers = Object.fromEntries(
      Object.entries(data.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const { 'in-reply-to': inReplyTo, references, 'reply-to': replyTo, ...extraHeaders } = headers;
    const from = data.fromEmail || this.config.auth.email;

    return {
      from,
      to: formatRecipients(data.to),
      cc: data.cc?.length ? formatRecipients(data.cc) : undefined,
      bcc: data.bcc?.length ? formatRecipients(data.bcc) : undefined,
      subject: data.subject,
      html: data.message,
      // Threading headers: declared-but-dropped in AxMail's sender; passed
      // through here so replies thread correctly on the receiving end.
      inReplyTo,
      references,
      replyTo,
      headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
      attachments: data.attachments?.map((a) => ({
        filename: a.name,
        content: a.base64,
        encoding: 'base64' as const,
        contentType: a.type || 'application/octet-stream',
      })),
    };
  }

  public create(data: IOutgoingMessage) {
    return this.withErrorHandler(
      'create',
      async () => {
        const mailOptions = this.outgoingToMailOptions(data);
        const { raw, messageId } = await this.renderRawMime(mailOptions);
        const recipients = [
          ...(mailOptions.to ?? []),
          ...(mailOptions.cc ?? []),
          ...(mailOptions.bcc ?? []),
        ];
        await this.smtpSend(mailOptions.from, recipients, raw);
        await this.appendToSent(raw).catch(async (error) => {
          // The SMTP send succeeded, so this failure must never throw — but
          // a dead cached IMAP connection silently losing the Sent copy is
          // exactly the failure class the /rpc reconnect retry can't see
          // (nothing threw at the /rpc level). One fresh-connection retry
          // before conceding (Phase 6.1 hardening, observed live).
          console.warn(
            '[ImapSmtpMailManager] append to Sent failed, retrying on a fresh connection:',
            (error as Error).message,
          );
          await this.dispose().catch(() => undefined);
          await this.appendToSent(raw).catch((retryError) =>
            console.warn(
              '[ImapSmtpMailManager] append to Sent failed:',
              (retryError as Error).message,
            ),
          );
        });
        return { id: normalizeMessageId(messageId) ?? null };
      },
      { email: this.config.auth.email },
    );
  }

  public sendDraft(draftId: string, data: IOutgoingMessage) {
    return this.withErrorHandler(
      'sendDraft',
      async () => {
        await this.create(data);
        await this.deleteDraft(draftId).catch((error) =>
          console.warn('[ImapSmtpMailManager] draft cleanup failed:', (error as Error).message),
        );
      },
      { draftId },
    );
  }

  public createDraft(data: CreateDraftData) {
    return this.withErrorHandler(
      'createDraft',
      async () => {
        const splitList = (value: string | null | undefined) =>
          value
            ? value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

        const mailOptions = {
          from: data.fromEmail || this.config.auth.email,
          to: splitList(data.to),
          cc: splitList(data.cc),
          bcc: splitList(data.bcc),
          subject: data.subject,
          html: data.message,
          attachments: data.attachments?.map((a) => ({
            filename: a.name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content: (a as any).base64 ?? '',
            encoding: 'base64' as const,
            contentType: a.type || 'application/octet-stream',
          })),
        };

        const { raw } = await this.renderRawMime(mailOptions);
        const draftsPath = await this.resolveFolder('drafts', true);
        if (!draftsPath) return { id: null, success: false, error: 'No Drafts folder' };

        const client = await this.connect();
        const appended = await client.append(draftsPath, raw, ['\\Draft']);

        // Replace-on-update: remove the previous version after the new
        // append succeeded (mirrors AxMail syncDraft ordering).
        if (data.id) {
          const previous = decodeMessageId(data.id);
          if (previous) {
            await client.mailboxOpen(previous.folder);
            await client.messageFlagsAdd(String(previous.uid), ['\\Deleted'], { uid: true });
            await client.messageDelete(String(previous.uid), { uid: true });
          }
        }

        let newDraftId: string | null = null;
        if (appended && appended.uid) {
          const uidValidity =
            appended.uidValidity ?? (await client.mailboxOpen(draftsPath)).uidValidity;
          newDraftId = encodeMessageId(draftsPath, uidValidity, appended.uid);
        }
        return { id: newDraftId, success: true };
      },
      { draftId: data.id },
    );
  }

  public getDraft(id: string) {
    return this.withErrorHandler(
      'getDraft',
      async () => {
        const decoded = decodeMessageId(id);
        if (!decoded) throw new Error(`Invalid draft id: ${id}`);
        const client = await this.connect();
        await client.mailboxOpen(decoded.folder);
        const item = await client.fetchOne(
          String(decoded.uid),
          { source: true, uid: true },
          { uid: true },
        );
        if (!item || !item.source) throw new Error('Draft not found');
        const parsed = await simpleParser(item.source);
        const html = typeof parsed.html === 'string' ? parsed.html : '';
        return {
          id,
          to: addressList(parsed.to).map((a) => a.email),
          cc: parsed.cc ? addressList(parsed.cc).map((a) => a.email) : undefined,
          bcc: parsed.bcc ? addressList(parsed.bcc).map((a) => a.email) : undefined,
          subject: parsed.subject ?? '',
          content: html || parsed.text || '',
          rawMessage: { internalDate: (parsed.date ?? new Date()).toISOString() },
        } satisfies ParsedDraft;
      },
      { id },
    );
  }

  public listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }) {
    const { maxResults = 20, pageToken } = params;
    return this.withErrorHandler(
      'listDrafts',
      async () => {
        const path = await this.resolveFolder('drafts');
        if (!path) return { threads: [], nextPageToken: null };
        const client = await this.connect();
        const mailbox = await client.mailboxOpen(path);
        if (mailbox.exists === 0) return { threads: [], nextPageToken: null };

        const offset = Number(pageToken ?? 0) || 0;
        const end = mailbox.exists - offset;
        if (end < 1) return { threads: [], nextPageToken: null };
        const start = Math.max(1, end - maxResults + 1);

        const drafts: { id: string; historyId: string | null; $raw: unknown }[] = [];
        for await (const item of client.fetch(`${start}:${end}`, {
          envelope: true,
          uid: true,
        })) {
          drafts.push({
            id: encodeMessageId(path, mailbox.uidValidity, item.uid),
            historyId: null,
            $raw: {
              subject: item.envelope?.subject ?? '',
              to: item.envelope?.to?.map((a) => a.address ?? '') ?? [],
              date: (item.envelope?.date ?? new Date(0)).toISOString(),
            },
          });
        }
        drafts.reverse(); // newest first

        return {
          threads: drafts,
          nextPageToken: start > 1 ? String(offset + (end - start + 1)) : null,
        };
      },
      { maxResults, pageToken },
    );
  }

  public deleteDraft(id: string) {
    return this.withErrorHandler(
      'deleteDraft',
      async () => {
        const decoded = decodeMessageId(id);
        if (!decoded) throw new Error(`Invalid draft id: ${id}`);
        const client = await this.connect();
        await client.mailboxOpen(decoded.folder);
        await client.messageFlagsAdd(String(decoded.uid), ['\\Deleted'], { uid: true });
        await client.messageDelete(String(decoded.uid), { uid: true });
      },
      { id },
    );
  }

  // ------------------------------------------------------------------
  // Attachments / raw source
  // ------------------------------------------------------------------

  private async fetchParsedByMessageId(id: string): Promise<ParsedMail> {
    const decoded = decodeMessageId(id);
    if (!decoded) throw new Error(`Invalid message id: ${id}`);
    const client = await this.connect();
    const mailbox = await client.mailboxOpen(decoded.folder);
    if (String(mailbox.uidValidity) !== decoded.uidValidity) {
      throw new Error(`Stale message id (UIDVALIDITY changed) for folder ${decoded.folder}`);
    }
    const item = await client.fetchOne(String(decoded.uid), { source: true, uid: true }, { uid: true });
    if (!item || !item.source) throw new Error('Message not found');
    return simpleParser(item.source);
  }

  public getMessageAttachments(id: string) {
    return this.withErrorHandler(
      'getMessageAttachments',
      async () => {
        const parsed = await this.fetchParsedByMessageId(id);
        return (parsed.attachments ?? []).map((a, index) => ({
          filename: a.filename ?? 'attachment',
          mimeType: a.contentType ?? 'application/octet-stream',
          size: a.size ?? a.content?.length ?? 0,
          attachmentId: String(index),
          headers: [] as { name: string; value: string }[],
          body: a.content ? Buffer.from(a.content).toString('base64') : '',
        }));
      },
      { id },
    );
  }

  public getAttachment(messageId: string, attachmentId: string) {
    return this.withErrorHandler(
      'getAttachment',
      async () => {
        const parsed = await this.fetchParsedByMessageId(messageId);
        const attachment = (parsed.attachments ?? [])[Number(attachmentId)];
        if (!attachment?.content) return undefined;
        return Buffer.from(attachment.content).toString('base64');
      },
      { messageId, attachmentId },
    );
  }

  public getRawEmail(id: string) {
    return this.withErrorHandler(
      'getRawEmail',
      async () => {
        const decoded = decodeMessageId(id);
        if (!decoded) throw new Error(`Invalid message id: ${id}`);
        const client = await this.connect();
        await client.mailboxOpen(decoded.folder);
        const item = await client.fetchOne(String(decoded.uid), { source: true, uid: true }, { uid: true });
        if (!item || !item.source) throw new Error('No raw email data found');
        return item.source.toString('utf-8');
      },
      { id },
    );
  }

  // ------------------------------------------------------------------
  // Read state, labels, moves
  // ------------------------------------------------------------------

  public markAsRead(threadIds: string[]) {
    return this.withErrorHandler(
      'markAsRead',
      async () => this.setReadState(threadIds, true),
      { threadIds },
    );
  }

  public markAsUnread(threadIds: string[]) {
    return this.withErrorHandler(
      'markAsUnread',
      async () => this.setReadState(threadIds, false),
      { threadIds },
    );
  }

  private async setReadState(threadIds: string[], read: boolean): Promise<void> {
    const members = await this.resolveThreadMembers(threadIds, ['inbox', 'archive', 'junk']);
    const client = await this.connect();
    for (const [folder, uids] of members) {
      await client.mailboxOpen(folder);
      const range = uids.join(',');
      if (read) await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
      else await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
    }
  }

  public normalizeIds(ids: string[]) {
    const threadIds = ids.map((id) => (id.startsWith('thread:') ? id.substring(7) : id));
    return { threadIds };
  }

  public modifyLabels(ids: string[], options: { addLabels: string[]; removeLabels: string[] }) {
    return this.withErrorHandler(
      'modifyLabels',
      async () => {
        const { threadIds } = this.normalizeIds(ids);
        const add = new Set(options.addLabels ?? []);
        const remove = new Set(options.removeLabels ?? []);
        const client = await this.connect();

        // --- Moves (system folders are locations on IMAP, not tags) -----
        let moveTarget: FolderKind | undefined;
        if (add.has('TRASH')) moveTarget = 'trash';
        else if (add.has('SPAM')) moveTarget = 'junk';
        else if (add.has('INBOX')) moveTarget = 'inbox';
        else if (remove.has('INBOX')) moveTarget = 'archive';

        if (moveTarget) {
          const sourceKinds: FolderKind[] = (
            ['inbox', 'archive', 'junk', 'trash'] as FolderKind[]
          ).filter((k) => k !== moveTarget);
          const members = await this.resolveThreadMembers(threadIds, sourceKinds);
          const targetPath = await this.resolveFolder(moveTarget, true);
          if (targetPath) {
            for (const [folder, uids] of members) {
              if (folder === targetPath) continue;
              await client.mailboxOpen(folder);
              await client.messageMove(uids.join(','), targetPath, { uid: true });
            }
          }
        }

        // --- Flags and keywords ----------------------------------------
        const flagOps: { addFlags: string[]; removeFlags: string[] } = {
          addFlags: [],
          removeFlags: [],
        };
        if (add.has('STARRED')) flagOps.addFlags.push('\\Flagged');
        if (remove.has('STARRED')) flagOps.removeFlags.push('\\Flagged');
        if (add.has('UNREAD')) flagOps.removeFlags.push('\\Seen');
        if (remove.has('UNREAD')) flagOps.addFlags.push('\\Seen');

        for (const label of add) {
          if (SYSTEM_LABEL_IDS.has(label)) continue;
          const keyword = await this.resolveKeyword(label);
          if (keyword) flagOps.addFlags.push(keyword);
        }
        for (const label of remove) {
          if (SYSTEM_LABEL_IDS.has(label)) continue;
          const keyword = await this.resolveKeyword(label);
          if (keyword) flagOps.removeFlags.push(keyword);
        }

        if (flagOps.addFlags.length > 0 || flagOps.removeFlags.length > 0) {
          const members = await this.resolveThreadMembers(threadIds);
          for (const [folder, uids] of members) {
            await client.mailboxOpen(folder);
            const range = uids.join(',');
            if (flagOps.addFlags.length > 0)
              await client.messageFlagsAdd(range, flagOps.addFlags, { uid: true });
            if (flagOps.removeFlags.length > 0)
              await client.messageFlagsRemove(range, flagOps.removeFlags, { uid: true });
          }
        }
      },
      { ids, options },
    );
  }

  // ------------------------------------------------------------------
  // Labels CRUD
  // ------------------------------------------------------------------

  public getUserLabels() {
    return this.withErrorHandler('getUserLabels', async () => {
      const system: Label[] = [
        { id: 'INBOX', name: 'Inbox', type: 'system' },
        { id: 'SENT', name: 'Sent', type: 'system' },
        { id: 'DRAFT', name: 'Drafts', type: 'system' },
        { id: 'SPAM', name: 'Spam', type: 'system' },
        { id: 'TRASH', name: 'Trash', type: 'system' },
        { id: 'ARCHIVE', name: 'Archive', type: 'system' },
      ];
      const registry = await this.loadRegistry();
      const user: Label[] = registry.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
        type: 'user',
      }));
      return [...system, ...user];
    });
  }

  public getLabel(id: string) {
    return this.withErrorHandler(
      'getLabel',
      async () => {
        const all = await this.getUserLabels();
        const label = all.find((l) => l.id === id || l.name === id);
        if (!label) throw new Error(`Label ${id} not found`);
        return label;
      },
      { id },
    );
  }

  public createLabel(label: {
    name: string;
    color?: { backgroundColor: string; textColor: string };
  }) {
    return this.withErrorHandler(
      'createLabel',
      async () => {
        const registry = await this.loadRegistry();
        if (registry.some((l) => l.name.toLowerCase() === label.name.toLowerCase())) return;
        const slug = slugify(label.name);
        if (!slug) throw new Error(`Label name "${label.name}" is not usable as an IMAP keyword`);
        let id = `${KEYWORD_PREFIX}${slug}`;
        // Keyword ids stay stable across renames, so guard against collisions.
        let suffix = 1;
        while (registry.some((l) => l.id === id)) id = `${KEYWORD_PREFIX}${slug}_${suffix++}`;
        registry.push({ id, name: label.name, color: label.color });
        await this.saveRegistry(registry);
      },
      { name: label.name },
    );
  }

  public updateLabel(
    id: string,
    label: { name: string; color?: { backgroundColor: string; textColor: string } },
  ) {
    return this.withErrorHandler(
      'updateLabel',
      async () => {
        const registry = await this.loadRegistry();
        const entry = registry.find((l) => l.id === id);
        if (!entry) throw new Error(`Label ${id} not found`);
        // The IMAP keyword (id) is intentionally immutable: renaming it would
        // require rewriting flags on every message carrying it.
        entry.name = label.name;
        entry.color = label.color;
        await this.saveRegistry(registry);
      },
      { id },
    );
  }

  public deleteLabel(id: string) {
    return this.withErrorHandler(
      'deleteLabel',
      async () => {
        const registry = await this.loadRegistry();
        const next = registry.filter((l) => l.id !== id);
        if (next.length === registry.length) return;
        await this.saveRegistry(next);

        // Best-effort keyword sweep; stray keywords are invisible once the
        // registry entry is gone, so failures here are non-fatal.
        try {
          const client = await this.connect();
          for (const kind of THREAD_MEMBER_FOLDERS) {
            const path = await this.resolveFolder(kind);
            if (!path) continue;
            await client.mailboxOpen(path);
            const uids = (await client.search({ keyword: id }, { uid: true })) || [];
            if (uids.length > 0) {
              await client.messageFlagsRemove(uids.join(','), [id], { uid: true });
            }
          }
        } catch (error) {
          console.warn('[ImapSmtpMailManager] keyword sweep failed:', (error as Error).message);
        }
      },
      { id },
    );
  }

  // ------------------------------------------------------------------
  // Counts, deletes
  // ------------------------------------------------------------------

  public count() {
    return this.withErrorHandler('count', async () => {
      const client = await this.connect();
      const results: { count?: number; label?: string }[] = [];
      const kinds: { kind: FolderKind; label: string; total: boolean }[] = [
        { kind: 'inbox', label: 'inbox', total: false },
        { kind: 'sent', label: 'sent', total: true },
        { kind: 'drafts', label: 'drafts', total: true },
        { kind: 'junk', label: 'spam', total: false },
        { kind: 'trash', label: 'trash', total: false },
        { kind: 'archive', label: 'archive', total: false },
      ];
      for (const { kind, label, total } of kinds) {
        const path = await this.resolveFolder(kind);
        if (!path) continue;
        try {
          const status = await client.status(path, { messages: true, unseen: true });
          results.push({ label, count: total ? (status.messages ?? 0) : (status.unseen ?? 0) });
        } catch {
          // Folder listed but not STATUS-able; skip.
        }
      }
      return results;
    });
  }

  public delete(id: string) {
    return this.withErrorHandler(
      'delete',
      async () => {
        const client = await this.connect();
        const asMessage = decodeMessageId(id);
        if (asMessage) {
          await client.mailboxOpen(asMessage.folder);
          await client.messageFlagsAdd(String(asMessage.uid), ['\\Deleted'], { uid: true });
          await client.messageDelete(String(asMessage.uid), { uid: true });
          return;
        }
        // Thread id: hard-delete every member, matching Gmail's
        // users.messages.delete semantics.
        const members = await this.resolveThreadMembers(
          [id],
          ['inbox', 'sent', 'archive', 'drafts', 'junk', 'trash'],
        );
        for (const [folder, uids] of members) {
          await client.mailboxOpen(folder);
          const range = uids.join(',');
          await client.messageFlagsAdd(range, ['\\Deleted'], { uid: true });
          await client.messageDelete(range, { uid: true });
        }
      },
      { id },
    );
  }

  public deleteAllSpam() {
    return this.withErrorHandler('deleteAllSpam', async () => {
      const junkPath = await this.resolveFolder('junk');
      if (!junkPath) {
        return { success: true, message: 'No spam folder found', count: 0 } satisfies DeleteAllSpamResponse;
      }
      const client = await this.connect();
      const mailbox = await client.mailboxOpen(junkPath);
      if (mailbox.exists === 0) {
        return { success: true, message: 'Deleted 0 spam emails', count: 0 } satisfies DeleteAllSpamResponse;
      }
      const uids = (await client.search({ all: true }, { uid: true })) || [];
      if (uids.length === 0) {
        return { success: true, message: 'Deleted 0 spam emails', count: 0 } satisfies DeleteAllSpamResponse;
      }
      const trashPath = await this.resolveFolder('trash', true);
      if (!trashPath) {
        return {
          success: false,
          message: 'No trash folder available',
          error: 'No trash folder available',
        } satisfies DeleteAllSpamResponse;
      }
      await client.messageMove(uids.join(','), trashPath, { uid: true });
      return {
        success: true,
        message: `Deleted ${uids.length} spam emails`,
        count: uids.length,
      } satisfies DeleteAllSpamResponse;
    });
  }

  // ------------------------------------------------------------------
  // OAuth-shaped methods (IMAP has no OAuth; stubbed per plan, mirroring
  // OutlookMailManager's listHistory precedent)
  // ------------------------------------------------------------------

  public async getTokens(
    _code: string,
  ): Promise<{ tokens: { access_token?: string; refresh_token?: string; expiry_date?: number } }> {
    return { tokens: {} };
  }

  public getScope(): string {
    return '';
  }

  public async revokeToken(_token: string): Promise<boolean> {
    // Nothing to revoke; report success so unlink flows proceed.
    return true;
  }

  public listHistory<T>(historyId: string): Promise<{ history: T[]; historyId: string }> {
    // Incremental sync for IMAP arrives via IDLE/polling, not history ids.
    return Promise.resolve({ history: [] as T[], historyId });
  }

  public async getUserInfo(tokens?: ManagerConfig['auth']) {
    const address = tokens?.email ?? this.config.auth.email;
    return {
      address,
      name: address.split('@')[0] ?? address,
      photo: '',
    };
  }

  public async getEmailAliases() {
    return [{ email: this.config.auth.email, primary: true }];
  }
}
