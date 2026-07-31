import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let _mb = await client.mailboxOpen('INBOX');
  
  let uids1 = await client.search({ text: ['rabbit', 'hole'] }, { uid: true });
  console.log('text array ->', uids1);
  
  await client.logout();
}
run().catch(console.error);
