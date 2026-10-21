import pool from "../src/db.js";
import { migrate } from "../src/schema.js";

try {
  await migrate();
  const { rows } = await pool.query<{ database: string }>(
    "SELECT current_database() AS database"
  );
  console.log(`[migrate] schema applied to "${rows[0].database}"`);
} catch (err) {
  console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
