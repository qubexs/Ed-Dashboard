import pg from "pg";
import { config } from "./config.js";

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("[db] unexpected idle client error", err);
});

export default pool;

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  version: string;
  database: string;
  serverTime: Date;
  error?: string;
}

export async function health(): Promise<DbHealth> {
  const started = Date.now();
  const { rows } = await pool.query<{
    version: string;
    database: string;
    now: Date;
  }>("SELECT version() AS version, current_database() AS database, now() AS now");
  return {
    ok: true,
    latencyMs: Date.now() - started,
    version: rows[0].version,
    database: rows[0].database,
    serverTime: rows[0].now,
  };
}
