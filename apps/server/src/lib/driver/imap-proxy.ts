import type {
  IGetThreadResponse,
  MailManager,
  ManagerConfig,
  ParsedDraft,
} from './types';
import type { IOutgoingMessage, Label, DeleteAllSpamResponse } from '../../types';
import type { CreateDraftData } from '../schemas';
import { env } from '../../env';

/**
 * workerd-side stand-in for ImapSmtpMailManager.
 *
 * workerd cannot open the raw IMAP/SMTP TLS sockets the driver needs (its
 * node:tls shim rejects self-signed certs and doesn't implement
 * rejectUnauthorized), so the real driver runs in a Node sidecar. This proxy
 * implements the same MailManager interface and forwards each call to the
 * sidecar over 127.0.0.1 as `{ method, args, auth }`, guarded by a shared
 * secret. Results are the interface's JSON DTOs, so one generic forwarder
 * covers every async method.
 *
 * Pure, side-effect-free methods (getScope/normalizeIds) are answered locally
 * to avoid a network hop.
 */
export class ImapSmtpProxyMailManager implements MailManager {
  private readonly sidecarUrl: string;
  private readonly secret: string;

  constructor(public config: ManagerConfig) {
    if (!config.auth?.imap) {
      throw new Error('ImapSmtpProxyMailManager requires config.auth.imap');
    }
    const url = env.IMAP_SIDECAR_URL;
    const secret = env.IMAP_SIDECAR_SECRET;
    if (!url || !secret) {
      throw new Error(
        'IMAP sidecar not configured: set IMAP_SIDECAR_URL and IMAP_SIDECAR_SECRET',
      );
    }
    this.sidecarUrl = url.replace(/\/$/, '');
    this.secret = secret;
  }

  private async rpc<T>(method: string, args: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.sidecarUrl}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-imap-sidecar-secret': this.secret,
        },
        body: JSON.stringify({ method, args, auth: this.config.auth }),
      });
    } catch (cause) {
      throw new Error(
        `IMAP sidecar unreachable at ${this.sidecarUrl} (${(cause as Error).message})`,
      );
    }

    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text };
    }

    if (!res.ok || payload?.error) {
      const err = new Error(
        payload?.error || `IMAP sidecar ${method} failed (HTTP ${res.status})`,
      ) as Error & { code?: string };
      err.code = payload?.code;
      throw err;
    }
    return payload.result as T;
  }

  // --- Local pure methods (no sidecar round-trip) ---
  getScope(): string {
    return '';
  }

  normalizeIds(ids: string[]): { threadIds: string[] } {
    return { threadIds: ids.map((id) => (id.startsWith('thread:') ? id.substring(7) : id)) };
  }

  // --- Forwarded methods ---
  /** Not part of MailManager; used by the add-account flow to fail fast. */
  testConnection(): Promise<{ connected: boolean; reason?: string }> {
    return this.rpc('testConnection', []);
  }

  getMessageAttachments(id: string) {
    return this.rpc<
      {
        filename: string;
        mimeType: string;
        size: number;
        attachmentId: string;
        headers: { name: string; value: string }[];
        body: string;
      }[]
    >('getMessageAttachments', [id]);
  }

  get(id: string): Promise<IGetThreadResponse> {
    return this.rpc('get', [id]);
  }

  create(data: IOutgoingMessage): Promise<{ id?: string | null }> {
    return this.rpc('create', [data]);
  }

  sendDraft(id: string, data: IOutgoingMessage): Promise<void> {
    return this.rpc('sendDraft', [id, data]);
  }

  createDraft(
    data: CreateDraftData,
  ): Promise<{ id?: string | null; success?: boolean; error?: string }> {
    return this.rpc('createDraft', [data]);
  }

  getDraft(id: string): Promise<ParsedDraft> {
    return this.rpc('getDraft', [id]);
  }

  listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }): Promise<{
    threads: { id: string; historyId: string | null; $raw: unknown }[];
    nextPageToken: string | null;
  }> {
    return this.rpc('listDrafts', [params]);
  }

  delete(id: string): Promise<void> {
    return this.rpc('delete', [id]);
  }

  deleteDraft(id: string): Promise<void> {
    return this.rpc('deleteDraft', [id]);
  }

  list(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string | number;
  }): Promise<{
    threads: { id: string; historyId: string | null; $raw?: unknown }[];
    nextPageToken: string | null;
  }> {
    return this.rpc('list', [params]);
  }

  count(): Promise<{ count?: number; label?: string }[]> {
    return this.rpc('count', []);
  }

  getTokens(
    code: string,
  ): Promise<{ tokens: { access_token?: string; refresh_token?: string; expiry_date?: number } }> {
    return this.rpc('getTokens', [code]);
  }

  getUserInfo(
    tokens?: ManagerConfig['auth'],
  ): Promise<{ address: string; name: string; photo: string }> {
    return this.rpc('getUserInfo', [tokens]);
  }

  listHistory<T>(historyId: string): Promise<{ history: T[]; historyId: string }> {
    return this.rpc('listHistory', [historyId]);
  }

  markAsRead(threadIds: string[]): Promise<void> {
    return this.rpc('markAsRead', [threadIds]);
  }

  markAsUnread(threadIds: string[]): Promise<void> {
    return this.rpc('markAsUnread', [threadIds]);
  }

  modifyLabels(
    id: string[],
    options: { addLabels: string[]; removeLabels: string[] },
  ): Promise<void> {
    return this.rpc('modifyLabels', [id, options]);
  }

  getAttachment(messageId: string, attachmentId: string): Promise<string | undefined> {
    return this.rpc('getAttachment', [messageId, attachmentId]);
  }

  getUserLabels(): Promise<Label[]> {
    return this.rpc('getUserLabels', []);
  }

  getLabel(id: string): Promise<Label> {
    return this.rpc('getLabel', [id]);
  }

  createLabel(label: {
    name: string;
    color?: { backgroundColor: string; textColor: string };
  }): Promise<void> {
    return this.rpc('createLabel', [label]);
  }

  updateLabel(
    id: string,
    label: { name: string; color?: { backgroundColor: string; textColor: string } },
  ): Promise<void> {
    return this.rpc('updateLabel', [id, label]);
  }

  deleteLabel(id: string): Promise<void> {
    return this.rpc('deleteLabel', [id]);
  }

  getEmailAliases(): Promise<{ email: string; name?: string; primary?: boolean }[]> {
    return this.rpc('getEmailAliases', []);
  }

  revokeToken(token: string): Promise<boolean> {
    return this.rpc('revokeToken', [token]);
  }

  deleteAllSpam(): Promise<DeleteAllSpamResponse> {
    return this.rpc('deleteAllSpam', []);
  }

  getRawEmail(id: string): Promise<string> {
    return this.rpc('getRawEmail', [id]);
  }
}
