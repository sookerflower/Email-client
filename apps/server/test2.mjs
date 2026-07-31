import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let mb = await client.mailboxOpen('INBOX');
  console.log('client exists:', mb.exists);
  await client.logout();
}
run().catch(console.error);
