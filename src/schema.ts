import fs from "node:fs/promises";
import path from "node:path";
import pool from "./db.js";

const schemaPath = path.join(process.cwd(), "db", "schema.sql");

export async function migrate(): Promise<void> {
  const sql = await fs.readFile(schemaPath, "utf8");
  await pool.query(sql);
}
