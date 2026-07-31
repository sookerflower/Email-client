import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let _mb = await client.mailboxOpen('INBOX');
  
  let uids1 = await client.search({ to: 'bob' }, { uid: true });
  console.log('to: bob ->', uids1);
  let uids2 = await client.search({ cc: 'charlie' }, { uid: true });
  console.log('cc: charlie ->', uids2);
  let uids3 = await client.search({ header: { 'to': 'bob' } }, { uid: true });
  console.log('header to: bob ->', uids3);
  let uids4 = await client.search({ header: { 'cc': 'charlie' } }, { uid: true });
  console.log('header cc: charlie ->', uids4);
  
  await client.logout();
}
run().catch(console.error);
