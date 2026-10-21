import type { QueryResult, QueryResultRow } from "pg";
import pool from "../db.js";
import { ApiError } from "../utils/apiError.js";
import { zonedInputToDate } from "../utils/datetime.js";

export const PATIENT_STATUSES = [
  "waiting",
  "in_treatment",
  "waiting_ward",
  "discharged",
  "cancelled",
] as const;

export type PatientStatus = (typeof PATIENT_STATUSES)[number];

export interface PatientRecord {
  id: number;
  external_id: string | null;
  medical_no: string | null;
  name: string | null;
  zone_code: string | null;
  status: string;
  arrived_at: Date;
  triaged_at: Date | null;
  called_at: Date | null;
  discharged_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>;
}

export interface PatientUpsertInput {
  external_id?: unknown;
  medical_no?: unknown;
  name?: unknown;
  zone_code?: unknown;
  status?: unknown;
  arrived_at?: unknown;
  triaged_at?: unknown;
  called_at?: unknown;
  discharged_at?: unknown;
  notes?: unknown;
}

export interface PatientUpsertResult {
  patient: PatientRecord;
  created: boolean;
}

export function isPatientStatus(value: unknown): value is PatientStatus {
  return (
    typeof value === "string" &&
    (PATIENT_STATUSES as readonly string[]).includes(value)
  );
}

export function statusTimestamps(
  status: string,
  patient: Pick<PatientRecord, "triaged_at" | "called_at" | "discharged_at">,
  now = new Date()
): { triaged_at: Date | null; called_at: Date | null; discharged_at: Date | null } {
  const result = {
    triaged_at: patient.triaged_at,
    called_at: patient.called_at,
    discharged_at: patient.discharged_at,
  };

  if (status === "waiting") {
    result.called_at = null;
    result.discharged_at = null;
  } else {
    if (
      !result.called_at &&
      ["in_treatment", "waiting_ward", "discharged"].includes(status)
    ) {
      result.called_at = now;
    }
    if (status === "discharged" && !result.discharged_at) {
      result.discharged_at = now;
    }
  }

  return result;
}

export function parseTimestamp(
  value: unknown,
  field: string,
  timeZone: string
): Date | null {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ApiError(400, `${field} must be a valid timestamp.`);
    }
    return date;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, `${field} must be an ISO-8601 timestamp string.`);
  }

  const text = value.trim();
  if (!text) return null;

  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(text);
  const date = naive
    ? zonedInputToDate(text.replace(" ", "T"), timeZone)
    : new Date(text);

  if (!date || Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${field} must be a valid ISO-8601 timestamp.`);
  }
  return date;
}

function requireExternalId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "external_id is required.");
  }
  const externalId = value.trim();
  if (externalId.length > 120) {
    throw new ApiError(400, "external_id must be at most 120 characters.");
  }
  return externalId;
}

function optionalText(
  value: unknown,
  field: string,
  max: number
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, `${field} must be a string.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new ApiError(400, `${field} must be at most ${max} characters.`);
  }
  return text || null;
}

async function assertZone(client: Queryable, code: string): Promise<void> {
  const { rows } = await client.query<{ code: string }>(
    "SELECT code FROM zones WHERE code = $1 AND active = true",
    [code]
  );
  if (!rows.length) {
    throw new ApiError(400, `Unknown or inactive zone "${code}".`);
  }
}

export async function upsertPatientByExternalId(
  input: PatientUpsertInput,
  timeZone: string,
  client: Queryable = pool
): Promise<PatientUpsertResult> {
  const externalId = requireExternalId(input.external_id);

  const { rows } = await client.query<PatientRecord>(
    "SELECT * FROM patients WHERE external_id = $1",
    [externalId]
  );
  const existing = rows[0];

  let status = existing?.status ?? "waiting";
  if (input.status !== undefined) {
    if (!isPatientStatus(input.status)) {
      throw new ApiError(
        400,
        `status must be one of: ${PATIENT_STATUSES.join(", ")}.`
      );
    }
    status = input.status;
  }

  const medicalNo =
    input.medical_no === undefined
      ? existing?.medical_no ?? null
      : optionalText(input.medical_no, "medical_no", 60);
  const name =
    input.name === undefined
      ? existing?.name ?? null
      : optionalText(input.name, "name", 120);
  const notes =
    input.notes === undefined
      ? existing?.notes ?? null
      : optionalText(input.notes, "notes", 500);

  let zoneCode = existing?.zone_code ?? null;
  if (input.zone_code !== undefined) {
    if (input.zone_code === null || input.zone_code === "") {
      zoneCode = null;
    } else {
      zoneCode = String(input.zone_code).trim().toLowerCase();
      await assertZone(client, zoneCode);
    }
  }
  if (!existing && !zoneCode) {
    throw new ApiError(400, "zone_code is required when creating a patient.");
  }

  let arrivedAt: Date | null = existing?.arrived_at ?? null;
  if (input.arrived_at !== undefined) {
    arrivedAt = parseTimestamp(input.arrived_at, "arrived_at", timeZone);
  }
  if (!arrivedAt) {
    if (existing) {
      throw new ApiError(400, "arrived_at cannot be empty.");
    }
    arrivedAt = new Date();
  }

  const triagedAt =
    input.triaged_at === undefined
      ? existing?.triaged_at ?? null
      : parseTimestamp(input.triaged_at, "triaged_at", timeZone);
  const calledAt =
    input.called_at === undefined
      ? existing?.called_at ?? null
      : parseTimestamp(input.called_at, "called_at", timeZone);
  const dischargedAt =
    input.discharged_at === undefined
      ? existing?.discharged_at ?? null
      : parseTimestamp(input.discharged_at, "discharged_at", timeZone);

  const stamps = statusTimestamps(status, {
    triaged_at: triagedAt,
    called_at: calledAt,
    discharged_at: dischargedAt,
  });

  if (existing) {
    const { rows: updated } = await client.query<PatientRecord>(
      `UPDATE patients
          SET medical_no = $2, name = $3, zone_code = $4, status = $5,
              arrived_at = $6, triaged_at = $7, called_at = $8,
              discharged_at = $9, notes = $10, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        existing.id,
        medicalNo,
        name,
        zoneCode,
        status,
        arrivedAt,
        stamps.triaged_at,
        stamps.called_at,
        stamps.discharged_at,
        notes,
      ]
    );

    if (["discharged", "cancelled"].includes(status)) {
      await client.query(
        "UPDATE ward_admissions SET status = 'cancelled', updated_at = now() WHERE patient_id = $1 AND status = 'waiting'",
        [existing.id]
      );
    }

    return { patient: updated[0], created: false };
  }

  const { rows: inserted } = await client.query<PatientRecord>(
    `INSERT INTO patients
       (external_id, medical_no, name, zone_code, status, arrived_at,
        triaged_at, called_at, discharged_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      externalId,
      medicalNo,
      name,
      zoneCode,
      status,
      arrivedAt,
      stamps.triaged_at,
      stamps.called_at,
      stamps.discharged_at,
      notes,
    ]
  );

  return { patient: inserted[0], created: true };
}
