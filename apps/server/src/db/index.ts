import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

const createDrizzle = (conn: Sql) => drizzle(conn, { schema });

let cachedConn: Sql | null = null;
let cachedDb: ReturnType<typeof createDrizzle> | null = null;

export const createDb = (url: string) => {
  if (!cachedConn) {
    cachedConn = postgres(url, { max: 20, idle_timeout: 30 });
    cachedDb = createDrizzle(cachedConn);
  }
  return { db: cachedDb!, conn: cachedConn };
};

export type DB = ReturnType<typeof createDrizzle>;
