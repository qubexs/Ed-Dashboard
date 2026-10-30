import pool from "../src/db.js";
import { migratePms } from "../src/pms/schema.js";
import { getCounts, resetDemo, seedDemo } from "../src/pms/store.js";

const force = process.argv.includes("--force");

try {
  await migratePms();
  const counts = await getCounts();

  if (counts.total > 0 && !force) {
    console.log(
      `[pms:seed] skipped, ${counts.total} rows already exist (use --force to reset)`
    );
  } else {
    if (force) await resetDemo();
    const created = await seedDemo(40);
    console.log(`[pms:seed] inserted ${created} demo patients`);
  }
} catch (err) {
  console.error("[pms:seed] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
