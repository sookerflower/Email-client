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
        smtpPort: 3025,
        imapTls: false
      }
    }
  });

  const client = await (mgr as any).connect();
  const mailboxes = await client.list();
  console.log(mailboxes.map(m => ({ path: m.path, specialUse: m.specialUse })));
  client.logout();
  process.exit(0);
}

run().catch(console.error);
