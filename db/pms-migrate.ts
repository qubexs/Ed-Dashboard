import pool from "../src/db.js";
import { migratePms, PMS_SCHEMA } from "../src/pms/schema.js";

try {
  await migratePms();
  console.log(`[pms:migrate] schema "${PMS_SCHEMA}" applied`);
} catch (err) {
  console.error(
    "[pms:migrate] failed:",
    err instanceof Error ? err.message : err
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
