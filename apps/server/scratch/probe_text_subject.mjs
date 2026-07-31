import { ImapFlow } from 'imapflow';
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student2@classroom.test', pass: 'secret123' }, logger: false });
async function run() {
  await client.connect();
  let _mb = await client.mailboxOpen('INBOX');
  
  // Try fetching all subjects first to get a runId
  let all = await client.search('ALL', { uid: true });
  console.log('all ->', all.length);

  // Use a known subject snippet
  let uids = await client.search({ text: 'hole', subject: 'Matrix' }, { uid: true });
  console.log('text hole + subject Matrix ->', uids.length);

  await client.logout();
}
run().catch(console.error);
