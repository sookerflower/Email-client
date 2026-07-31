const run = async () => {
  const result = await (await fetch('http://127.0.0.1:8787/api/trpc/mail.listThreads?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22folder%22%3A%22inbox%22%2C%22maxResults%22%3A100%7D%7D%7D')).json();
  const threads = result[0].result.data.json.threads;
  console.log(`Found ${threads.length} threads`);
  for (const t of threads) {
    const thread = await (await fetch(`http://127.0.0.1:8787/api/trpc/mail.get?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22id%22%3A%22${t.id}%22%7D%7D%7D`)).json();
    const subject = thread[0].result.data.json.latest?.subject;
    console.log(`Thread ${t.id}: ${subject}`);
  }
};
run();
