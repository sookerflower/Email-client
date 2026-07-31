import { ImapFlow } from 'imapflow';
const client = new ImapFlow({
  host: '127.0.0.1',
  port: 3143,
  secure: false,
  auth: { user: 'student@classroom.test', pass: 'secret123' },
  logger: false,
});
await client.connect();
const lock1 = await client.getMailboxLock('INBOX');
console.log('Exists:', client.mailbox.exists);

const client2 = new ImapFlow({
  host: '127.0.0.1',
  port: 3143,
  secure: false,
  auth: { user: 'student@classroom.test', pass: 'secret123' },
  logger: false,
});
await client2.connect();
await client2.append('INBOX', 'From: test@example.com\r\n\r\ntest\r\n', []);
await client2.logout();

console.log('Exists in client1 before NOOP:', client.mailbox.exists);
await client.noop();
console.log('Exists after NOOP:', client.mailbox.exists);

lock1.release();
await client.logout();
