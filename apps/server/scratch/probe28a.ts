import { ImapSmtpMailManager } from '../src/lib/driver/imap';

async function run() {
  const mgr = new ImapSmtpMailManager({
    auth: {
      email: 'user@example.com',
      connectionId: 'probe28',
      imap: {
        imapHost: 'localhost',
        imapPort: 3143,
        username: 'user1@example.com',
        password: 'password123',
        smtpHost: 'localhost',
        smtpPort: 3025
      }
    }
  });

  const trash = await (mgr as any).resolveFolder('trash');
  const junk = await (mgr as any).resolveFolder('junk');
  const drafts = await (mgr as any).resolveFolder('drafts');
  
  console.log({ trash, junk, drafts });
  process.exit(0);
}

run().catch(console.error);
