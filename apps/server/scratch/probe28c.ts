import { ImapSmtpMailManager } from '../src/lib/driver/imap';

async function run() {
  const mgr = new ImapSmtpMailManager({
    auth: {
      email: 'abhishek@m.re.cx',
      connectionId: 'probe28_real',
      imap: {
        imapHost: 'res72238.m.re.cx',
        imapPort: 993,
        username: 'abhishek@m.re.cx',
        password: 'Resul@0903',
        smtpHost: 'res72238.m.re.cx',
        smtpPort: 587,
        imapTls: true,
        allowInsecureTls: true // Self-signed cert
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
