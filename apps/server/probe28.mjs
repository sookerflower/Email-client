import { ImapSmtpMailManager } from './dist-node/server.mjs';

async function run() {
  const mgr = new ImapSmtpMailManager({
    auth: { email: 'user@example.com', connectionId: 'probe28' },
    imapConfig: {
      host: 'localhost',
      port: 3143,
      secure: false,
      auth: { user: 'user1@example.com', pass: 'password123' },
    },
    smtpConfig: {
      host: 'localhost',
      port: 3025,
      secure: false,
      auth: { user: 'user1@example.com', pass: 'password123' },
    }
  });

  const trash = await mgr.resolveFolder('trash');
  const junk = await mgr.resolveFolder('junk');
  const drafts = await mgr.resolveFolder('drafts');
  
  console.log({ trash, junk, drafts });
  process.exit(0);
}

run().catch(console.error);
