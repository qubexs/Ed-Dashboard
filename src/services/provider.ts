import pool from "../db.js";
import { PATIENT_STATUSES, isPatientStatus } from "./patients.js";
import { WARD_STATUSES } from "./wards.js";
import { ApiError } from "../utils/apiError.js";

export interface ListFilters {
  status?: string;
  zone?: string;
  limit: number;
  offset: number;
}

export interface ListResult<T> {
  items: T[];
  total: number;
}

const PATIENT_COLUMNS = `
  id, external_id, medical_no, name, zone_code, status,
  arrived_at, triaged_at, called_at, discharged_at, notes,
  created_at, updated_at,
  ROUND(EXTRACT(EPOCH FROM (now() - arrived_at)) / 60)::int AS waiting_minutes`;

const WARD_COLUMNS = `
  w.id, w.external_id, w.patient_id, w.patient_name, w.ward, w.status,
  w.requested_at, w.admitted_at, w.created_at, w.updated_at,
  p.external_id AS patient_external_id,
  p.zone_code AS patient_zone_code,
  ROUND(EXTRACT(EPOCH FROM (now() - w.requested_at)) / 60)::int AS waiting_minutes`;

function checkPatientStatus(value: string | undefined): void {
  if (value !== undefined && !isPatientStatus(value)) {
    throw new ApiError(
      400,
      `status must be one of: ${PATIENT_STATUSES.join(", ")}.`
    );
  }
}

function checkWardStatus(value: string | undefined): void {
  if (
    value !== undefined &&
    !(WARD_STATUSES as readonly string[]).includes(value)
  ) {
    throw new ApiError(
      400,
      `status must be one of: ${WARD_STATUSES.join(", ")}.`
    );
  }
}

export async function listPatients(
  filters: ListFilters
): Promise<ListResult<Record<string, unknown>>> {
  checkPatientStatus(filters.status);

  const { rows } = await pool.query(
    `SELECT ${PATIENT_COLUMNS}
       FROM patients
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR zone_code = $2)
      ORDER BY arrived_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [filters.status ?? null, filters.zone ?? null, filters.limit, filters.offset]
  );

  const count = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM patients
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR zone_code = $2)`,
    [filters.status ?? null, filters.zone ?? null]
  );

  return { items: rows, total: count.rows[0]?.count ?? 0 };
}

export async function getPatient(
  identifier: string
): Promise<Record<string, unknown> | null> {
  const isNumericId = /^\d+$/.test(identifier);

  const { rows } = await pool.query(
    `SELECT ${PATIENT_COLUMNS}
       FROM patients
      WHERE ${isNumericId ? "id = $1::bigint" : "external_id = $1"}
      LIMIT 1`,
    [identifier]
  );

  return rows[0] ?? null;
}

export async function listWards(
  filters: ListFilters
): Promise<ListResult<Record<string, unknown>>> {
  checkWardStatus(filters.status);

  const { rows } = await pool.query(
    `SELECT ${WARD_COLUMNS}
       FROM ward_admissions w
       LEFT JOIN patients p ON p.id = w.patient_id
      WHERE ($1::text IS NULL OR w.status = $1)
      ORDER BY w.status = 'waiting' DESC, w.requested_at ASC
      LIMIT $2 OFFSET $3`,
    [filters.status ?? null, filters.limit, filters.offset]
  );

  const count = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM ward_admissions w
      WHERE ($1::text IS NULL OR w.status = $1)`,
    [filters.status ?? null]
  );

  return { items: rows, total: count.rows[0]?.count ?? 0 };
}

export async function listZones(): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `SELECT z.code, z.name, z.name_en, z.color, z.sort_order, z.active,
            COUNT(p.id) FILTER (
              WHERE p.status IN ('waiting', 'in_treatment', 'waiting_ward')
            )::int AS count
       FROM zones z
       LEFT JOIN patients p ON p.zone_code = z.code
      GROUP BY z.code, z.name, z.name_en, z.color, z.sort_order, z.active
      ORDER BY z.sort_order, z.code`
  );
  return rows;
}

export async function getStats(): Promise<Record<string, number>> {
  const { rows } = await pool.query<Record<string, number>>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('waiting', 'in_treatment', 'waiting_ward'))::int AS active,
       COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
       COUNT(*) FILTER (WHERE status = 'in_treatment')::int AS in_treatment,
       COUNT(*) FILTER (WHERE status = 'waiting_ward')::int AS waiting_ward,
       COUNT(*) FILTER (WHERE status = 'discharged')::int AS discharged,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       COUNT(*)::int AS patients,
       (SELECT COUNT(*)::int FROM ward_admissions WHERE status = 'waiting') AS wards_waiting,
       (SELECT COUNT(*)::int FROM ward_admissions) AS wards
     FROM patients`
  );
  return rows[0] ?? {};
}
