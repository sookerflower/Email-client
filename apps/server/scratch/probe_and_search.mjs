import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let _mb = await client.mailboxOpen('INBOX');
  
  let uids1 = await client.search([{ subject: 'Alice' }, { subject: 'vro' }], { uid: true });
  console.log('array AND ->', uids1);
  try {
    let uids2 = await client.search({ and: [{ subject: 'Alice' }, { subject: 'vro' }] }, { uid: true });
    console.log('object AND ->', uids2);
  } catch (e) { console.log('object AND error', e.message); }
  
  await client.logout();
}
run().catch(console.error);
