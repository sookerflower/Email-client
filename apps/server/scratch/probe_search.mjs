import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let mb = await client.mailboxOpen('INBOX');
  console.log('client exists:', mb.exists);
  
  let uids = await client.search({ all: true }, { uid: true });
  console.log('uids:', uids);
  let seqs = await client.search({ all: true }, { uid: false });
  console.log('seqs:', seqs);
  
  if (uids.length > 0) {
    let i = 0;
    for await (const _msg of client.fetch(uids, { envelope: true, flags: true, uid: true }, { uid: true })) {
      i++;
    }
    console.log('fetched messages by specific UIDs:', i);
  }
  
  await client.logout();
}
run().catch(console.error);
