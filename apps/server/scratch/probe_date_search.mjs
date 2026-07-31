import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let _mb = await client.mailboxOpen('INBOX');
  
  let uids1 = await client.search({ before: new Date('2021-01-01T00:00:00Z') }, { uid: true });
  console.log('before: 2021-01-01 ->', uids1);
  let uids2 = await client.search({ since: new Date('2021-01-01T00:00:00Z') }, { uid: true });
  console.log('since: 2021-01-01 ->', uids2);
  let uids3 = await client.search({ sentBefore: new Date('2021-01-01T00:00:00Z') }, { uid: true });
  console.log('sentBefore: 2021-01-01 ->', uids3);
  let uids4 = await client.search({ sentSince: new Date('2021-01-01T00:00:00Z') }, { uid: true });
  console.log('sentSince: 2021-01-01 ->', uids4);
  
  await client.logout();
}
run().catch(console.error);
