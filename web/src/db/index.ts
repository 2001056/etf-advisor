import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// dev HMR에서 풀이 중복 생성되지 않도록 globalThis에 보관
const globalForDb = globalThis as unknown as { pgPool?: Pool };

const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });

globalForDb.pgPool = pool;

export const db = drizzle(pool, { schema });
export type Db = typeof db;
