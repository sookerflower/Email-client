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
  await client.messageFlagsAdd('1:*', ['\\Deleted'], { uid: false });
  await client.messageDelete('1:*', { uid: false });
  console.log('Wiped INBOX');
} catch (err) {
  console.log('Error wiping', err.message);
} finally {
  lock.release();
}
await client.logout();
