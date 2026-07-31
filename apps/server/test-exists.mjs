import { ImapFlow } from 'imapflow';
const client1 = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'test1@example.com', pass: 'secret123' }, logger: false });
const client2 = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'test1@example.com', pass: 'secret123' }, logger: false });

async function run() {
  await client1.connect();
  await client2.connect();
  
  let mb1 = await client1.mailboxOpen('INBOX');
  console.log('client1 exists before append:', mb1.exists);
  
  await client2.append('INBOX', 'From: test\r\n\r\ntest', { flags: [] });
  console.log('client2 appended.');
  
  await client1.noop();
  console.log('client1 exists after noop:', client1.mailbox.exists);
  
  await client1.logout();
  await client2.logout();
}
run().catch(console.error);
