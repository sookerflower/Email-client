import { ImapFlow } from 'imapflow';
const client = new ImapFlow({
  host: '127.0.0.1',
  port: 3143,
  secure: false,
  auth: { user: 'student@classroom.test', pass: 'secret123' },
  logger: false,
});
await client.connect();
const lock = await client.getMailboxLock('INBOX');
try {
  for await (const message of client.fetch('1:*', { envelope: true })) {
    console.log(message.uid, message.envelope.subject, message.envelope.messageId);
  }
} finally {
  lock.release();
}
await client.logout();
