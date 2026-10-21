import bcrypt from "bcryptjs";
import pool from "./db.js";
import { config } from "./config.js";
import { migrate } from "./schema.js";
import { seedDemo } from "./seed.js";

export async function ensureAdmin(): Promise<{ created: boolean }> {
  const { rows } = await pool.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM users"
  );
  if (rows[0].count > 0) return { created: false };

  const hash = await bcrypt.hash(config.adminPassword, 12);
  await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
    [config.adminUsername, hash]
  );

  if (config.adminPassword === "admin123") {
    console.warn(
      "[bootstrap] created default admin account with the default password. Change it in Admin > Users."
    );
  } else {
    console.log(`[bootstrap] created admin account "${config.adminUsername}"`);
  }
  return { created: true };
}

export async function bootstrap(): Promise<void> {
  await migrate();
  await ensureAdmin();

  if (config.seedDemo) {
    const result = await seedDemo();
    if (!result.skipped) {
      console.log(
        `[bootstrap] seeded ${result.patients} demo patients and ${result.wardAdmissions} ward admissions`
      );
    }
  }
}
