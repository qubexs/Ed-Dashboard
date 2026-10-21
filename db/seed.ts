import pool from "../src/db.js";
import { seedDemo } from "../src/seed.js";

try {
  const result = await seedDemo({ force: process.argv.includes("--force") });
  if (result.skipped) {
    console.log(
      `[seed] skipped, patients table already has ${result.patients} rows (use --force to reset demo data)`
    );
  } else {
    console.log(
      `[seed] inserted ${result.patients} demo patients and ${result.wardAdmissions} ward admissions`
    );
  }
} catch (err) {
  console.error("[seed] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
