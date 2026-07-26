import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

const createDrizzle = (conn: Sql) => drizzle(conn, { schema });

let cachedConn: Sql | null = null;
let cachedDb: ReturnType<typeof createDrizzle> | null = null;

export const createDb = (url: string) => {
  if (!cachedConn) {
    cachedConn = postgres(url, { max: 20, idle_timeout: 30 });
    // ~13 call sites written in the workerd per-request era call
    // `conn.end()` when they finish. Since the pool became a process-wide
    // singleton, any one of them ending it poisons every later query in
    // the process with CONNECTION_ENDED (observed live: the composeEmail
    // chat tool killed the whole api's DB access). The shared pool's
    // lifetime is the process's — make end() a no-op at the source rather
    // than chase every caller.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cachedConn as any).end = async () => undefined;
    cachedDb = createDrizzle(cachedConn);
  }
  return { db: cachedDb!, conn: cachedConn };
};

export type DB = ReturnType<typeof createDrizzle>;
