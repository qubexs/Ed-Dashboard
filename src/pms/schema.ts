import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import pool from "../db.js";

const VALID_SCHEMA = /^[a-z_][a-z0-9_]*$/i;

/** Postgres schema owned by the PMS. Validated to keep it SQL-injectable-proof. */
export const PMS_SCHEMA = VALID_SCHEMA.test(config.pmsSchema)
  ? config.pmsSchema
  : "pms";

export const PMS_TABLES = {
  patients: `${PMS_SCHEMA}.patients`,
  wards: `${PMS_SCHEMA}.ward_requests`,
  patientSeq: `${PMS_SCHEMA}.patient_no_seq`,
  wardSeq: `${PMS_SCHEMA}.ward_no_seq`,
};

export async function migratePms(): Promise<void> {
  const schemaPath = path.join(process.cwd(), "db", "pms-schema.sql");
  const sql = (await fs.readFile(schemaPath, "utf8")).replaceAll(
    "{{schema}}",
    PMS_SCHEMA
  );
  await pool.query(sql);
}
