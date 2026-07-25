import { verifyImapCredentials, upsertImapConnection } from './imap-connections';
import { getBrowserTimezone, isValidTimezone } from './timezones';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import { defaultUserSettings } from './schemas';
import { getZeroDB } from './server-utils';
import { env } from '../env';
import { z } from 'zod';

/**
 * Custom IMAP/SMTP sign-in for better-auth.
 *
 * POST /api/auth/sign-in/imap with { email, password [, host overrides] }:
 * 1. Verifies the credentials live against the mail server (via the
 *    transport sidecar) — the mail server is the credential authority;
 *    no password hash is stored app-side, ever.
 * 2. First login: creates the user (emailVerified — a successful IMAP login
 *    proves mailbox ownership) and seeds default settings.
 * 3. Upserts the mailbox as a `connection` row (same helper as the
 *    add-account form), so signing in IS adding the mailbox.
 * 4. Creates a standard better-auth session + cookie via the same internal
 *    adapter used by social sign-in — downstream code cannot tell the login
 *    methods apart.
 *
 * Deliberately creates NO `account` row: sessions attach to users, and the
 * account-table databaseHooks (connectionHandlerHook) are OAuth-only.
 *
 * Host/port fields are optional; they default to the deployment's mail
 * server via IMAP_DEFAULT_* env vars so classroom users only type
 * email + password.
 */
export const imapAuthPlugin = () =>
  ({
    id: 'imap-auth',
    endpoints: {
      signInImap: createAuthEndpoint(
        '/sign-in/imap',
        {
          method: 'POST',
          body: z.object({
            email: z.string().email(),
            password: z.string().min(1),
            username: z.string().optional(),
            imapHost: z.string().optional(),
            imapPort: z.number().int().min(1).max(65535).optional(),
            smtpHost: z.string().optional(),
            smtpPort: z.number().int().min(1).max(65535).optional(),
            allowInsecureTls: z.boolean().optional(),
          }),
        },
        async (ctx) => {
          const body = ctx.body;
          const imapHost = body.imapHost || env.IMAP_DEFAULT_IMAP_HOST;
          const smtpHost = body.smtpHost || env.IMAP_DEFAULT_SMTP_HOST;
          if (!imapHost || !smtpHost) {
            throw new APIError('BAD_REQUEST', {
              message: 'No mail server configured: provide IMAP/SMTP hosts',
            });
          }
          const imapPort = body.imapPort ?? Number(env.IMAP_DEFAULT_IMAP_PORT ?? 993);
          const smtpPort = body.smtpPort ?? Number(env.IMAP_DEFAULT_SMTP_PORT ?? 587);

          const input = {
            email: body.email.trim(),
            username: (body.username || body.email).trim(),
            password: body.password,
            imapHost,
            imapPort,
            // 993/465 are implicit-TLS ports; 143/587 negotiate STARTTLS.
            imapSecure: imapPort === 993,
            smtpHost,
            smtpPort,
            smtpSecure: smtpPort === 465,
            allowInsecureTls:
              body.allowInsecureTls ?? env.IMAP_DEFAULT_ALLOW_INSECURE_TLS === 'true',
          };

          // 1. Live credential check — nothing is written before this passes.
          const verdict = await verifyImapCredentials('sign-in-probe', input);
          if (!verdict.ok) {
            throw new APIError(verdict.kind === 'unreachable' ? 'SERVICE_UNAVAILABLE' : 'UNAUTHORIZED', {
              message: verdict.reason,
            });
          }

          // 2. Find or create the user.
          const existing = await ctx.context.internalAdapter.findUserByEmail(input.email);
          let user = existing?.user ?? null;
          const isNewUser = !user;
          if (!user) {
            user = await ctx.context.internalAdapter.createUser(
              {
                email: input.email,
                name: input.email.split('@')[0] ?? input.email,
                emailVerified: true,
              },
              ctx,
            );
            if (!user) {
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create user' });
            }
          }

          // 3. Seed default settings for first-time users (mirrors the
          // /sign-up after-hook, which our custom path does not trigger).
          if (isNewUser) {
            const db = await getZeroDB(user.id);
            const existingSettings = await db.findUserSettings();
            if (!existingSettings) {
              const headerTimezone = ctx.headers?.get('x-vercel-ip-timezone');
              const timezone =
                headerTimezone && isValidTimezone(headerTimezone)
                  ? headerTimezone
                  : getBrowserTimezone();
              await db.insertUserSettings({ ...defaultUserSettings, timezone });
            }
          }

          // 4. Signing in IS adding the mailbox.
          await upsertImapConnection(user.id, input, verdict.passwordEncrypted);

          // 5. Standard session, identical to social sign-in.
          const session = await ctx.context.internalAdapter.createSession(user.id, ctx);
          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create session' });
          }
          await setSessionCookie(ctx, { session, user });

          return ctx.json({
            status: true,
            user: { id: user.id, email: user.email, name: user.name },
          });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
