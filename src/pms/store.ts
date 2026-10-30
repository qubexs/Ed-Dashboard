import pool from "../db.js";
import { PMS_TABLES as T } from "./schema.js";

export const PATIENT_STATUSES = [
  "waiting",
  "in_treatment",
  "waiting_ward",
  "discharged",
  "cancelled",
] as const;

export type PatientStatus = (typeof PATIENT_STATUSES)[number];
export type TriageLevel = "green" | "yellow" | "red";
export type WardStatus = "waiting" | "admitted" | "cancelled";

export const TRIAGE_LEVELS: TriageLevel[] = ["green", "yellow", "red"];

export interface PmsPatient {
  id: string;
  external_id: string;
  medical_no: string | null;
  name: string;
  triage_level: TriageLevel;
  status: PatientStatus;
  arrived_at: Date;
  triaged_at: Date | null;
  called_at: Date | null;
  discharged_at: Date | null;
  notes: string | null;
  updated_at: Date;
  waiting_minutes: number;
}

export interface PmsWard {
  id: string;
  external_id: string;
  patient_external_id: string;
  patient_name: string;
  ward: string;
  status: WardStatus;
  requested_at: Date;
  admitted_at: Date | null;
  waiting_minutes: number;
}

export interface PmsCounts {
  active: number;
  waiting: number;
  in_treatment: number;
  waiting_ward: number;
  discharged: number;
  today: number;
  total: number;
  wards_waiting: number;
}

const WAITING_MINUTES = `ROUND(EXTRACT(EPOCH FROM (now() - arrived_at)) / 60)::int`;

function isPatientStatus(value: string): value is PatientStatus {
  return (PATIENT_STATUSES as readonly string[]).includes(value);
}

function isTriageLevel(value: string): value is TriageLevel {
  return (TRIAGE_LEVELS as readonly string[]).includes(value);
}

export function parseStatus(value: unknown): PatientStatus {
  const text = String(value ?? "").trim().toLowerCase();
  if (!isPatientStatus(text)) {
    throw new Error(`Unknown patient status "${String(value ?? "")}".`);
  }
  return text;
}

export function parseTriageLevel(value: unknown): TriageLevel {
  const text = String(value ?? "").trim().toLowerCase();
  if (!isTriageLevel(text)) {
    throw new Error(`Unknown triage level "${String(value ?? "")}".`);
  }
  return text;
}

export async function listPatients(limit = 200): Promise<PmsPatient[]> {
  const { rows } = await pool.query<PmsPatient>(
    `SELECT *, ${WAITING_MINUTES} AS waiting_minutes
       FROM ${T.patients}
      ORDER BY
        CASE status
          WHEN 'waiting' THEN 0
          WHEN 'in_treatment' THEN 1
          WHEN 'waiting_ward' THEN 2
          ELSE 3
        END,
        arrived_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function listActivePatients(): Promise<PmsPatient[]> {
  const { rows } = await pool.query<PmsPatient>(
    `SELECT *, ${WAITING_MINUTES} AS waiting_minutes
       FROM ${T.patients}
      WHERE status IN ('waiting', 'in_treatment', 'waiting_ward')
      ORDER BY arrived_at ASC`
  );
  return rows;
}

export async function listWards(limit = 100): Promise<PmsWard[]> {
  const { rows } = await pool.query<PmsWard>(
    `SELECT w.*,
            p.name AS patient_name,
            ROUND(EXTRACT(EPOCH FROM (now() - w.requested_at)) / 60)::int AS waiting_minutes
       FROM ${T.wards} w
       JOIN ${T.patients} p ON p.external_id = w.patient_external_id
      WHERE w.status <> 'cancelled'
      ORDER BY w.status = 'waiting' DESC, w.requested_at ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getCounts(): Promise<PmsCounts> {
  const { rows } = await pool.query<PmsCounts>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('waiting', 'in_treatment', 'waiting_ward'))::int AS active,
       COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
       COUNT(*) FILTER (WHERE status = 'in_treatment')::int AS in_treatment,
       COUNT(*) FILTER (WHERE status = 'waiting_ward')::int AS waiting_ward,
       COUNT(*) FILTER (WHERE status = 'discharged')::int AS discharged,
       COUNT(*) FILTER (WHERE arrived_at >= date_trunc('day', now()))::int AS today,
       COUNT(*)::int AS total
     FROM ${T.patients}`
  );
  const wards = await pool.query<{ waiting: number }>(
    `SELECT COUNT(*)::int AS waiting FROM ${T.wards} WHERE status = 'waiting'`
  );

  return { ...rows[0], wards_waiting: wards.rows[0]?.waiting ?? 0 };
}

export async function createPatient(input: {
  name: string;
  medical_no?: string | null;
  triage_level?: string;
  notes?: string | null;
  arrived_at?: Date | null;
}): Promise<PmsPatient> {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("Patient name is required.");
  if (name.length > 120) throw new Error("Patient name is too long.");

  const triage = parseTriageLevel(input.triage_level ?? "green");

  const { rows } = await pool.query<PmsPatient>(
    `INSERT INTO ${T.patients}
       (external_id, medical_no, name, triage_level, status, arrived_at, notes)
     VALUES
       ('PMS-' || lpad(nextval('${T.patientSeq}')::text, 5, '0'),
        $1, $2, $3, 'waiting', COALESCE($4, now()), $5)
     RETURNING *, ${WAITING_MINUTES} AS waiting_minutes`,
    [
      input.medical_no ? String(input.medical_no).trim() : null,
      name,
      triage,
      input.arrived_at ?? null,
      input.notes ? String(input.notes).trim() : null,
    ]
  );

  return rows[0];
}

export async function setPatientStatus(
  id: string,
  status: PatientStatus
): Promise<PmsPatient | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<PmsPatient>(
      `UPDATE ${T.patients}
          SET status = $2,
              triaged_at = CASE
                WHEN $2 IN ('in_treatment', 'waiting_ward', 'discharged')
                     AND triaged_at IS NULL THEN now()
                ELSE triaged_at END,
              called_at = CASE
                WHEN $2 = 'in_treatment' AND called_at IS NULL THEN now()
                ELSE called_at END,
              discharged_at = CASE
                WHEN $2 = 'discharged' THEN COALESCE(discharged_at, now())
                ELSE NULL END,
              updated_at = now()
        WHERE id = $1
        RETURNING *, ${WAITING_MINUTES} AS waiting_minutes`,
      [id, status]
    );

    const patient = rows[0];
    if (!patient) {
      await client.query("ROLLBACK");
      return null;
    }

    if (status === "discharged" || status === "cancelled") {
      await client.query(
        `UPDATE ${T.wards}
            SET status = 'cancelled', updated_at = now()
          WHERE patient_external_id = $1 AND status = 'waiting'`,
        [patient.external_id]
      );
    }

    await client.query("COMMIT");
    return patient;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function requestWard(
  patientId: string,
  ward: string
): Promise<PmsWard | null> {
  const wardName = String(ward ?? "").trim();
  if (!wardName) throw new Error("Ward name is required.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const patientResult = await client.query<{ external_id: string; status: PatientStatus }>(
      `SELECT external_id, status FROM ${T.patients} WHERE id = $1 FOR UPDATE`,
      [patientId]
    );
    const patient = patientResult.rows[0];
    if (!patient) {
      await client.query("ROLLBACK");
      return null;
    }
    if (patient.status === "discharged" || patient.status === "cancelled") {
      throw new Error("Cannot request a ward bed for a closed patient record.");
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM ${T.wards}
        WHERE patient_external_id = $1 AND status = 'waiting'`,
      [patient.external_id]
    );
    if (existing.rows.length > 0) {
      throw new Error("This patient already has a pending ward request.");
    }

    const { rows } = await client.query<PmsWard>(
      `INSERT INTO ${T.wards}
         (external_id, patient_external_id, ward, status, requested_at)
       VALUES
         ('WARD-' || lpad(nextval('${T.wardSeq}')::text, 5, '0'),
          $1, $2, 'waiting', now())
       RETURNING *, (SELECT name FROM ${T.patients} WHERE external_id = $1) AS patient_name,
                 0 AS waiting_minutes`,
      [patient.external_id, wardName]
    );

    await client.query(
      `UPDATE ${T.patients}
          SET status = 'waiting_ward', updated_at = now()
        WHERE id = $1`,
      [patientId]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function setWardStatus(
  id: string,
  status: Exclude<WardStatus, "waiting">
): Promise<PmsWard | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<PmsWard>(
      `UPDATE ${T.wards}
          SET status = $2,
              admitted_at = CASE WHEN $2 = 'admitted' THEN COALESCE(admitted_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE id = $1
        RETURNING *,
                  (SELECT name FROM ${T.patients} WHERE external_id = patient_external_id) AS patient_name,
                  ROUND(EXTRACT(EPOCH FROM (now() - requested_at)) / 60)::int AS waiting_minutes`,
      [id, status]
    );

    const ward = rows[0];
    if (!ward) {
      await client.query("ROLLBACK");
      return null;
    }

    if (status === "cancelled") {
      // Send the patient back to treatment if they were only waiting for a bed.
      await client.query(
        `UPDATE ${T.patients}
            SET status = 'in_treatment', updated_at = now()
          WHERE external_id = $1 AND status = 'waiting_ward'`,
        [ward.patient_external_id]
      );
    }

    await client.query("COMMIT");
    return ward;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const WARDS = [
  "Wad 1",
  "Wad 2",
  "Wad 3",
  "Wad 4",
  "Wad 5",
  "Wad 6",
  "Wad 7",
  "Wad 8",
  "ICU",
];

const FIRST_NAMES = [
  "Ahmad", "Aisyah", "Amir", "Anis", "Arif", "Ayu", "Danish", "Farah",
  "Firdaus", "Hafiz", "Hakim", "Hana", "Iman", "Irfan", "Khalid", "Lina",
  "Mei Ling", "Nadia", "Nora", "Rahman", "Ravi", "Siti", "Syafiq", "Wei Jian",
];

const LAST_NAMES = [
  "Abdullah", "Abu Bakar", "Ismail", "Hassan", "Ibrahim", "Yusof", "Rahman",
  "Sulaiman", "Tan", "Lim", "Lee", "Wong", "Kumar", "Raj", "Ng", "Omar",
];

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(items: T[]): T {
  return items[rand(0, items.length - 1)] as T;
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

export async function seedDemo(count = 40): Promise<number> {
  let created = 0;

  for (let i = 0; i < count; i += 1) {
    const triage = pick(["green", "green", "green", "yellow", "yellow", "red"]) as TriageLevel;
    const arrivedAt = minutesAgo(rand(0, 150));
    const patient = await createPatient({
      name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
      medical_no: `A${rand(100000, 999999)}`,
      triage_level: triage,
      arrived_at: arrivedAt,
    });
    created += 1;

    const roll = rand(1, 100);
    if (roll <= 25) {
      await setPatientStatus(patient.id, "in_treatment");
    } else if (roll <= 40) {
      const ward = await requestWard(patient.id, pick(WARDS) as string);
      if (ward && rand(1, 100) <= 40) {
        await setWardStatus(ward.id, "admitted");
      }
    } else if (roll <= 55) {
      await setPatientStatus(patient.id, "discharged");
    }
  }

  return created;
}

export async function resetDemo(): Promise<void> {
  await pool.query(
    `TRUNCATE ${T.wards}, ${T.patients} RESTART IDENTITY CASCADE`
  );
  await pool.query(`ALTER SEQUENCE ${T.patientSeq} RESTART WITH 1`);
  await pool.query(`ALTER SEQUENCE ${T.wardSeq} RESTART WITH 1`);
}

/** JSON shape the API server's pull worker expects on /api/patients. */
export function toApiPatient(patient: PmsPatient): Record<string, unknown> {
  return {
    external_id: patient.external_id,
    medical_no: patient.medical_no,
    name: patient.name,
    zone_code: patient.triage_level,
    status: patient.status,
    arrived_at: patient.arrived_at,
    triaged_at: patient.triaged_at,
    called_at: patient.called_at,
    discharged_at: patient.discharged_at,
    notes: patient.notes,
  };
}

export function toApiWard(ward: PmsWard): Record<string, unknown> {
  return {
    external_id: ward.external_id,
    patient_external_id: ward.patient_external_id,
    patient_name: ward.patient_name,
    ward: ward.ward,
    status: ward.status,
    requested_at: ward.requested_at,
    admitted_at: ward.admitted_at,
  };
}
