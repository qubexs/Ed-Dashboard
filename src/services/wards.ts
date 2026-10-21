import pool from "../db.js";
import { ApiError } from "../utils/apiError.js";
import {
  parseTimestamp,
  type Queryable,
} from "./patients.js";

export const WARD_STATUSES = ["waiting", "admitted", "cancelled"] as const;

export type WardStatus = (typeof WARD_STATUSES)[number];

export interface WardRecord {
  id: number;
  external_id: string | null;
  patient_id: number | null;
  patient_name: string | null;
  ward: string | null;
  status: string;
  requested_at: Date;
  admitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WardUpsertInput {
  external_id?: unknown;
  patient_external_id?: unknown;
  patient_name?: unknown;
  ward?: unknown;
  status?: unknown;
  requested_at?: unknown;
  admitted_at?: unknown;
}

export interface WardUpsertResult {
  admission: WardRecord;
  created: boolean;
}

function isWardStatus(value: unknown): value is WardStatus {
  return (
    typeof value === "string" &&
    (WARD_STATUSES as readonly string[]).includes(value)
  );
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

export async function upsertWardAdmissionByExternalId(
  input: WardUpsertInput,
  timeZone: string,
  client: Queryable = pool
): Promise<WardUpsertResult> {
  const externalId = requireExternalId(input.external_id);

  let patient: { id: number; name: string | null; status: string } | null = null;
  const patientExternalId =
    input.patient_external_id === undefined ||
    input.patient_external_id === null ||
    input.patient_external_id === ""
      ? null
      : String(input.patient_external_id).trim();

  if (patientExternalId) {
    if (patientExternalId.length > 120) {
      throw new ApiError(
        400,
        "patient_external_id must be at most 120 characters."
      );
    }
    const { rows } = await client.query<{
      id: number;
      name: string | null;
      status: string;
    }>(
      "SELECT id, name, status FROM patients WHERE external_id = $1",
      [patientExternalId]
    );
    patient = rows[0] ?? null;
    if (!patient) {
      throw new ApiError(
        400,
        `Patient "${patientExternalId}" was not found; sync the patient first.`
      );
    }
  }

  const { rows } = await client.query<WardRecord>(
    "SELECT * FROM ward_admissions WHERE external_id = $1",
    [externalId]
  );
  const existing = rows[0];

  let status = existing?.status ?? "waiting";
  if (input.status !== undefined) {
    if (!isWardStatus(input.status)) {
      throw new ApiError(
        400,
        `status must be one of: ${WARD_STATUSES.join(", ")}.`
      );
    }
    status = input.status;
  }

  const requestedAt =
    input.requested_at === undefined
      ? existing?.requested_at ?? new Date()
      : parseTimestamp(input.requested_at, "requested_at", timeZone);
  if (!requestedAt) {
    throw new ApiError(400, "requested_at cannot be empty.");
  }

  let admittedAt: Date | null;
  if (status === "admitted") {
    admittedAt =
      input.admitted_at === undefined
        ? existing?.admitted_at ?? new Date()
        : parseTimestamp(input.admitted_at, "admitted_at", timeZone);
    if (!admittedAt) admittedAt = new Date();
  } else if (status === "waiting") {
    admittedAt = null;
  } else {
    admittedAt =
      input.admitted_at === undefined
        ? existing?.admitted_at ?? null
        : parseTimestamp(input.admitted_at, "admitted_at", timeZone);
  }

  const ward =
    input.ward === undefined
      ? existing?.ward ?? null
      : optionalText(input.ward, "ward", 80);
  const patientName =
    input.patient_name === undefined
      ? existing?.patient_name ?? patient?.name ?? null
      : optionalText(input.patient_name, "patient_name", 120);

  if (!patient && !existing?.patient_id && !patientName) {
    throw new ApiError(
      400,
      "patient_external_id or patient_name is required."
    );
  }

  const patientId = patient?.id ?? existing?.patient_id ?? null;

  let admission: WardRecord;
  if (existing) {
    const { rows: updated } = await client.query<WardRecord>(
      `UPDATE ward_admissions
          SET patient_id = $2, patient_name = $3, ward = $4, status = $5,
              requested_at = $6, admitted_at = $7, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        existing.id,
        patientId,
        patientName,
        ward,
        status,
        requestedAt,
        admittedAt,
      ]
    );
    admission = updated[0];
  } else {
    const { rows: inserted } = await client.query<WardRecord>(
      `INSERT INTO ward_admissions
         (external_id, patient_id, patient_name, ward, status, requested_at, admitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        externalId,
        patientId,
        patientName,
        ward,
        status,
        requestedAt,
        admittedAt,
      ]
    );
    admission = inserted[0];
  }

  if (
    patient &&
    status === "waiting" &&
    ["waiting", "in_treatment"].includes(patient.status)
  ) {
    await client.query(
      "UPDATE patients SET status = 'waiting_ward', updated_at = now() WHERE id = $1",
      [patient.id]
    );
  }

  return { admission, created: !existing };
}
