import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let _mb = await client.mailboxOpen('INBOX');
  
  let uids1 = await client.search({ from: 'alice' }, { uid: true });
  console.log('from: alice ->', uids1);
  let uids2 = await client.search({ from: 'wonderland' }, { uid: true });
  console.log('from: wonderland ->', uids2);
  let uids3 = await client.search({ from: 'Alice' }, { uid: true });
  console.log('from: Alice ->', uids3);
  let uids4 = await client.search({ header: { 'from': 'alice' } }, { uid: true });
  console.log('header: from: alice ->', uids4);
  
  await client.logout();
}
run().catch(console.error);
