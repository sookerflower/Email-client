import { ImapSmtpProxyMailManager } from './driver/imap-proxy';
import { encryptPassword } from './driver/imap-crypto';
import { getZeroDB } from './server-utils';
import { EProviders } from '../types';
import { env } from '../env';

export interface ImapConnectionInput {
  email: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  allowInsecureTls: boolean;
}

export type ImapVerifyResult =
  | { ok: true; passwordEncrypted: string }
  | { ok: false; kind: 'unreachable' | 'rejected'; reason: string };

/**
 * Encrypt the password and verify the credentials against the live mail
 * server through the transport sidecar. Verification runs with the
 * ciphertext so the exact decrypt-on-use path the app relies on afterwards
 * is what gets exercised. No rows are written.
 */
export async function verifyImapCredentials(
  userId: string,
  input: ImapConnectionInput,
): Promise<ImapVerifyResult> {
  if (!env.IMAP_ENCRYPTION_KEY) {
    return { ok: false, kind: 'unreachable', reason: 'IMAP_ENCRYPTION_KEY is not configured' };
  }
  const passwordEncrypted = await encryptPassword(input.password, env.IMAP_ENCRYPTION_KEY);

  const probe = new ImapSmtpProxyMailManager({
    auth: {
      userId,
      accessToken: '',
      refreshToken: '',
      email: input.email,
      imap: {
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        imapSecure: input.imapSecure,
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpSecure: input.smtpSecure,
        username: input.username,
        passwordEncrypted,
        allowInsecureTls: input.allowInsecureTls,
      },
    },
  });

  let verdict: { connected: boolean; reason?: string };
  try {
    verdict = await probe.testConnection();
  } catch (error) {
    return {
      ok: false,
      kind: 'unreachable',
      reason: `Could not reach the IMAP transport service: ${(error as Error).message}`,
    };
  }
  if (!verdict.connected) {
    return {
      ok: false,
      kind: 'rejected',
      reason: verdict.reason ?? 'Could not connect with the provided credentials',
    };
  }
  return { ok: true, passwordEncrypted };
}

/**
 * Upsert the connection row for a verified IMAP account and make it the
 * user's default connection when they have none. Callers must have run
 * verifyImapCredentials first (this writes, it does not validate).
 */
export async function upsertImapConnection(
  userId: string,
  input: ImapConnectionInput,
  passwordEncrypted: string,
): Promise<{ id: string | undefined }> {
  const db = await getZeroDB(userId);
  const [result] = await db.createConnection(EProviders.imap, input.email, {
    // No OAuth expiry for IMAP; the row-level fields are the credentials.
    expiresAt: new Date('2100-01-01T00:00:00Z'),
    scope: 'imap',
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    username: input.username,
    passwordEncrypted,
    imapAllowInsecureTls: input.allowInsecureTls,
  });

  if (result?.id) {
    const existingUser = await db.findUser();
    if (existingUser && !existingUser.defaultConnectionId) {
      await db.updateUser({ defaultConnectionId: result.id });
    }
  }

  return { id: result?.id };
}
