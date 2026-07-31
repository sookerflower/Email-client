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

// Someone else appends 1 message
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

console.log('Appended from client2');
console.log('Exists in client1:', client.mailbox.exists); // still 0?

// Try to refresh
await client.status('INBOX', { messages: true });
console.log('Exists after status:', client.mailbox.exists);

lock1.release();
// Try mailboxClose
await client.mailboxClose();
const lock2 = await client.getMailboxLock('INBOX');
console.log('Exists after close/open:', client.mailbox.exists);
lock2.release();

await client.logout();
