import postgres from 'postgres';
const sql = postgres('postgres://zerodotemail:zerodotemail@127.0.0.1:5432/zerodotemail_test');
const res = await sql`SELECT * FROM mail0_thread WHERE subject LIKE '%Matrix%'`;
console.log('Threads:', res.length);
if (res.length > 0) {
  console.log(res[0]);
}
process.exit(0);
