import pool from "../src/db.js";
import { migrate } from "../src/schema.js";

try {
  await migrate();
  await pool.query("TRUNCATE ward_admissions, patients RESTART IDENTITY CASCADE");
  console.log("[reset] demo data cleared (users and settings kept)");
} catch (err) {
  console.error("[reset] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
