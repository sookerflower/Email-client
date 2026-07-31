import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let _mb = await client.mailboxOpen('INBOX');
  
  // Search for body text that is known to exist
  let uids1 = await client.search({ body: 'rabbit' }, { uid: true });
  console.log('body rabbit ->', uids1);
  
  let uids2 = await client.search({ body: 'hole' }, { uid: true });
  console.log('body hole ->', uids2);

  // Search for subject text using text
  let uids3 = await client.search({ text: 'Matrix' }, { uid: true });
  console.log('text Matrix ->', uids3.length);

  await client.logout();
}
run().catch(console.error);
