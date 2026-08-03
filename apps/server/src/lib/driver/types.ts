import type { IOutgoingMessage, ParsedMessage, Label, DeleteAllSpamResponse } from '../../types';
import { ParsedMessageSchema } from '../../types';
import type { CreateDraftData } from '../schemas';
import { z } from 'zod';

export interface IGetThreadResponse {
  messages: ParsedMessage[];
  latest?: ParsedMessage;
  hasUnread: boolean;
  totalReplies: number;
  labels: { id: string; name: string }[];
  isLatestDraft?: boolean;
}

export const IGetThreadResponseSchema = z.object({
  messages: z.array(ParsedMessageSchema),
  latest: ParsedMessageSchema.optional(),
  hasUnread: z.boolean(),
  totalReplies: z.number(),
  labels: z.array(z.object({ id: z.string(), name: z.string() })),
});

export interface ParsedDraft {
  id: string;
  to?: string[];
  subject?: string;
  content?: string;
  rawMessage?: {
    internalDate?: string | null;
  };
  cc?: string[];
  bcc?: string[];
}

export interface IConfig {
  auth?: {
    access_token: string;
    refresh_token: string;
    email: string;
  };
}

export type ImapSmtpAuthConfig = {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  /**
   * Plaintext password. Present only where the real ImapSmtpMailManager is
   * constructed (the Node sidecar decrypts `passwordEncrypted` into this, and
   * direct/test construction passes it straight in). Never persisted.
   */
  password?: string;
  /**
   * Ciphertext form as stored in the connection row. Carried over the wire to
   * the sidecar, which decrypts it. Present on the workerd/proxy side where the
   * plaintext must never appear.
   */
  passwordEncrypted?: string;
  /**
   * Explicit opt-in to accept self-signed / unverifiable TLS certificates
   * (disables certificate validation for this connection only). Prefer
   * installing a proper certificate on the mail server.
   */
  allowInsecureTls?: boolean;
};

export type ManagerConfig = {
  auth: {
    userId: string;
    // accountId: string;
    accessToken: string;
    refreshToken: string;
    email: string;
    /**
     * Connection row id, set by connectionToDriver for the imap provider so
     * the transport sidecar can register a new-mail watcher (IMAP IDLE) and
     * report changes back for this connection. OAuth drivers ignore it.
     */
    connectionId?: string;
    /** Present only for providerId 'imap'; OAuth drivers ignore it. */
    imap?: ImapSmtpAuthConfig;
  };
};

/**
 * Per-folder IMAP mailbox state (Phase 6.1 UIDVALIDITY guard; Phase 6.2
 * incremental-sync ladder). Optional on MailManager — IMAP-backed drivers
 * report it; Gmail/Microsoft (their sync is cursor-based) leave it absent
 * and the guard simply doesn't apply.
 */
export interface FolderState {
  folder: string;
  path: string;
  uidValidity: number | null;
  uidNext: number | null;
  /** 63-bit; kept as string to avoid JS precision loss. */
  highestModseq: string | null;
  messages: number | null;
}

/** One ledger entry produced by fetchFolderDelta (Phase 6.2). */
export interface FolderDeltaMessage {
  uid: number;
  threadId: string;
  /** Sorted flags joined with \x01 — change detection on the UID-diff floor. */
  flags: string;
}

export interface FolderDeltaCursor {
  uidValidity: number;
  uidNext: number;
  highestModseq: string | null;
}

export interface FolderDelta {
  mode: 'snapshot' | 'full' | 'condstore' | 'uid-diff';
  fullResyncRequired: boolean;
  messages: FolderDeltaMessage[];
  vanishedUids: number[];
  newCursor: FolderDeltaCursor;
}

/**
 * Parameters for MailManager.list.
 *
 * Every property here crosses the api -> worker JSON RPC boundary
 * (imap-proxy.rpc -> worker /rpc), so ONLY JSON-serializable data may be
 * added. A function-valued param is silently dropped by JSON.stringify and
 * arrives as `undefined` on the worker -- that is exactly how the `label:`
 * filter came to match every thread.
 *
 * Declared once and shared by the contract, the real driver and the proxy, so
 * a param added to one cannot silently go missing from another.
 */
/**
 * What a label mutation did to message LOCATIONS, reported back from the
 * server. `uidMap` is source-uid -> destination-uid, straight from the
 * UIDPLUS response to MOVE.
 *
 * `from`/`to` are app folder KINDS ('inbox', 'trash', 'junk', 'archive') --
 * the same keys the folder_message ledger uses -- normalized inside the
 * driver. Never IMAP paths: the first execution of the move path shipped
 * 'INBOX'/'Trash' and the ledger lookup missed silently.
 */
export interface MoveReport {
  moves: { from: string; to: string; uidMap: [number, number][] }[];
}

export interface ListParams {
  folder: string;
  query?: string;
  maxResults?: number;
  labelIds?: string[];
  pageToken?: string | number;
}

export interface MailManager {
  config: ManagerConfig;
  getFolderState?(folder: string): Promise<FolderState | null>;
  /**
   * Which system folder labels (INBOX/ARCHIVE/SPAM/TRASH) currently hold each
   * thread, read from the server. Optional: only the IMAP path implements it.
   * Used by write-through so the index is rebuilt from server truth rather
   * than from the caller's intent.
   */
  getThreadFolders?(threadIds: string[]): Promise<Record<string, string[]>>;
  fetchFolderDelta?(
    folder: string,
    cursor: (FolderDeltaCursor & { known: { uid: number; flags: string }[] }) | null,
    windowSize?: number,
  ): Promise<FolderDelta | null>;
  getMessageAttachments(id: string): Promise<
    {
      filename: string;
      mimeType: string;
      size: number;
      attachmentId: string;
      headers: { name: string; value: string }[];
      body: string;
    }[]
  >;
  get(id: string): Promise<IGetThreadResponse>;
  create(data: IOutgoingMessage): Promise<{ id?: string | null }>;
  sendDraft(id: string, data: IOutgoingMessage): Promise<void>;
  createDraft(
    data: CreateDraftData,
  ): Promise<{ id?: string | null; success?: boolean; error?: string }>;
  getDraft(id: string): Promise<ParsedDraft>;
  listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }): Promise<{
    threads: { id: string; historyId: string | null; $raw: unknown }[];
    nextPageToken: string | null;
  }>;
  delete(id: string): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  list(params: ListParams): Promise<{
    threads: { id: string; historyId: string | null; $raw?: unknown }[];
    nextPageToken: string | null;
    incomplete?: boolean;
  }>;
  count(): Promise<{ count?: number; label?: string }[]>;
  getTokens(
    code: string,
  ): Promise<{ tokens: { access_token?: string; refresh_token?: string; expiry_date?: number } }>;
  getUserInfo(
    tokens?: ManagerConfig['auth'],
  ): Promise<{ address: string; name: string; photo: string }>;
  getScope(): string;
  listHistory<T>(historyId: string): Promise<{ history: T[]; historyId: string }>;
  markAsRead(threadIds: string[]): Promise<void>;
  markAsUnread(threadIds: string[]): Promise<void>;
  normalizeIds(id: string[]): { threadIds: string[] };
  /**
   * Returns the moves it performed. A MOVE assigns a NEW uid in the
   * destination and expunges the source, so the caller's folder_message
   * ledger must follow it. Both supported servers advertise UIDPLUS, so
   * messageMove yields a source->destination uid map: report it rather than
   * making the caller re-fetch and infer which uid is which.
   */
  modifyLabels(
    id: string[],
    options: { addLabels: string[]; removeLabels: string[] },
  ): Promise<MoveReport | void>;
  getAttachment(messageId: string, attachmentId: string): Promise<string | undefined>;
  getUserLabels(): Promise<Label[]>;
  getLabel(id: string): Promise<Label>;
  createLabel(label: {
    name: string;
    color?: { backgroundColor: string; textColor: string };
  }): Promise<void>;
  updateLabel(
    id: string,
    label: { name: string; color?: { backgroundColor: string; textColor: string } },
  ): Promise<void>;
  deleteLabel(id: string): Promise<void>;
  getEmailAliases(): Promise<{ email: string; name?: string; primary?: boolean }[]>;
  revokeToken(token: string): Promise<boolean>;
  deleteAllSpam(): Promise<DeleteAllSpamResponse>;
  getRawEmail(id: string): Promise<string>;
}

export interface IGetThreadsResponse {
  threads: { id: string; historyId: string | null; $raw?: unknown }[];
  nextPageToken: string | null;
  incomplete?: boolean;
}

export const IGetThreadsResponseSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      historyId: z.string().nullable(),
      $raw: z.unknown().optional(),
    }),
  ),
  nextPageToken: z.string().nullable(),
  incomplete: z.boolean().optional(),
});
