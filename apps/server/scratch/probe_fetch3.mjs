import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: console });
async function run() {
  await client.connect();
  let mb = await client.mailboxOpen('INBOX');
  console.log('client exists:', mb.exists);
  
  let i = 0;
  for await (const _msg of client.fetch('1:*', { envelope: true, flags: true, uid: true }, { uid: true })) {
    i++;
  }
  console.log('fetched messages by UID (1:*):', i);
  
  await client.logout();
}
run().catch(console.error);
