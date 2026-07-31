import { ImapFlow } from 'imapflow';
(async () => {
  const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student@classroom.test', pass: 'secret123' }, logger: false });
  await client.connect();
  let lock1 = await client.getMailboxLock('INBOX');
  console.log('uidNext before:', client.mailbox.uidNext);
  
  const client2 = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'student@classroom.test', pass: 'secret123' }, logger: false });
  await client2.connect();
  await client2.append('INBOX', 'From: test@example.com\r\n\r\ntest\r\n', []);
  await client2.logout();
  
  const status = await client.status('INBOX', { uidNext: true });
  console.log('uidNext from status:', status.uidNext);
  console.log('uidNext in mailbox still:', client.mailbox.uidNext);
  
  lock1.release();
  await client.logout();
})();
