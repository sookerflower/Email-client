// import removed
import { ImapSmtpMailManager } from './imap.ts';



const driver = new ImapSmtpMailManager({
  auth: {
    connectionId: 'test-connection-id-123',
    email: 'student@classroom.test',
    imap: {
      host: '127.0.0.1',
      port: 3143,
      username: 'student@classroom.test',
      password: 'secret123',
      secure: false
    },
    smtp: {
      host: '127.0.0.1',
      port: 3025,
      username: 'student@classroom.test',
      password: 'secret123',
      secure: false
    }
  }
});

async function run() {
  console.log('Testing driver.list...');
  try {
    const list = await driver.list({ folder: 'inbox', maxResults: 50 });
    console.log('Threads:', list.threads.length);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
