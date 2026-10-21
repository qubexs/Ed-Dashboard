import type { PoolClient } from "pg";
import { config } from "../config.js";
import pool from "../db.js";
import { getSettings, updateSettings } from "./settings.js";
import {
  upsertPatientByExternalId,
  type PatientUpsertInput,
} from "./patients.js";
import {
  upsertWardAdmissionByExternalId,
  type WardUpsertInput,
} from "./wards.js";

const REQUEST_TIMEOUT_MS = 20_000;
const SCHEDULER_TICK_MS = 5_000;

const DEFAULT_PATIENT_MAP: Record<string, string> = {
  external_id: "external_id",
  medical_no: "medical_no",
  name: "name",
  zone_code: "zone_code",
  status: "status",
  arrived_at: "arrived_at",
  triaged_at: "triaged_at",
  called_at: "called_at",
  discharged_at: "discharged_at",
  notes: "notes",
};

const DEFAULT_WARD_MAP: Record<string, string> = {
  external_id: "external_id",
  patient_external_id: "patient_external_id",
  patient_name: "patient_name",
  ward: "ward",
  status: "status",
  requested_at: "requested_at",
  admitted_at: "admitted_at",
};

export interface PmsSyncResult {
  patients: { created: number; updated: number };
  wards: { created: number; updated: number };
  durationMs: number;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

export function isPmsSyncRunning(): boolean {
  return running;
}

function parseObject(raw: string, label: string): Record<string, string> {
  const text = String(raw || "").trim();
  if (!text) return {};

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    result[key] = item;
  }
  return result;
}

function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function mapRecord(
  item: unknown,
  map: Record<string, string>
): Record<string, unknown> {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("source record must be a JSON object.");
  }

  const result: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(map)) {
    result[field] = getPath(item, path);
  }
  return result;
}

function toText(
  value: unknown,
  field: string
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error(`${field} must be a string or number.`);
}

function mappedText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function toTimestamp(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e9 && value < 1e12 ? Math.round(value * 1000) : value;
  }
  return value;
}

function applyMap(
  value: unknown,
  map: Record<string, string>
): unknown {
  if (value === undefined || value === null) return value;
  const text = String(value).trim();
  if (map[text] !== undefined) return map[text];

  const lower = text.toLowerCase();
  for (const [key, mapped] of Object.entries(map)) {
    if (key.toLowerCase() === lower) return mapped;
  }
  return text;
}

function extractArray(payload: unknown, preferred: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;

  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    for (const key of [...preferred, "data", "items", "results"]) {
      if (Array.isArray(object[key])) return object[key] as unknown[];
    }

    const nested = object.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedObject = nested as Record<string, unknown>;
      for (const key of preferred) {
        if (Array.isArray(nestedObject[key])) {
          return nestedObject[key] as unknown[];
        }
      }
    }
  }

  throw new Error(
    `Expected a JSON array or an object with a "${preferred[0]}" array.`
  );
}

function buildUrl(baseUrl: string, path: string): string {
  const pathText = String(path || "").trim();
  if (!pathText) return "";
  if (/^https?:\/\//i.test(pathText)) return pathText;

  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  return `${base}/${pathText.replace(/^\/+/, "")}`;
}

async function fetchJson(
  url: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  label: string
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers[key] = value.replace(/\{\{apiKey\}\}/g, apiKey);
  }

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${label} endpoint returned HTTP ${response.status}.`);
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new Error(`${label} endpoint returned an empty response.`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} endpoint did not return valid JSON.`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `${label} endpoint timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`
      );
    }
    if (err instanceof Error && err.message.startsWith(`${label} endpoint`)) {
      throw err;
    }

    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code || cause?.message;
    throw new Error(
      `${label} endpoint request failed${detail ? `: ${detail}` : ""}.`
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildPatientInput(
  record: Record<string, unknown>,
  statusMap: Record<string, string>,
  zoneMap: Record<string, string>
): PatientUpsertInput {
  return {
    external_id: toText(record.external_id, "external_id"),
    medical_no: toText(record.medical_no, "medical_no"),
    name: toText(record.name, "name"),
    zone_code: mappedText(applyMap(record.zone_code, zoneMap))?.toLowerCase(),
    status: mappedText(applyMap(record.status, statusMap))?.toLowerCase(),
    arrived_at: toTimestamp(record.arrived_at),
    triaged_at: toTimestamp(record.triaged_at),
    called_at: toTimestamp(record.called_at),
    discharged_at: toTimestamp(record.discharged_at),
    notes: toText(record.notes, "notes"),
  };
}

function buildWardInput(
  record: Record<string, unknown>,
  statusMap: Record<string, string>
): WardUpsertInput {
  return {
    external_id: toText(record.external_id, "external_id"),
    patient_external_id: mappedText(record.patient_external_id),
    patient_name: toText(record.patient_name, "patient_name"),
    ward: toText(record.ward, "ward"),
    status: mappedText(applyMap(record.status, statusMap))?.toLowerCase(),
    requested_at: toTimestamp(record.requested_at),
    admitted_at: toTimestamp(record.admitted_at),
  };
}

async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

export async function runPmsSync(): Promise<PmsSyncResult> {
  if (running) {
    throw new Error("A PMS sync is already running.");
  }
  running = true;
  const started = Date.now();

  try {
    const settings = await getSettings();
    const baseUrl = settings.pms_base_url.trim();
    if (!baseUrl) {
      throw new Error("PMS base URL is not configured.");
    }

    const apiKey = config.pmsApiKey || settings.pms_api_key;
    const patientMap = {
      ...DEFAULT_PATIENT_MAP,
      ...parseObject(settings.pms_patient_map, "Patient field map"),
    };
    const wardMap = {
      ...DEFAULT_WARD_MAP,
      ...parseObject(settings.pms_ward_map, "Ward field map"),
    };
    const statusMap = parseObject(settings.pms_status_map, "Status map");
    const zoneMap = parseObject(settings.pms_zone_map, "Zone map");
    const extraHeaders = parseObject(settings.pms_headers, "Extra headers");

    const patientUrl = buildUrl(
      baseUrl,
      settings.pms_patients_path || "/patients"
    );
    const wardUrl = buildUrl(baseUrl, settings.pms_wards_path);
    if (!patientUrl) {
      throw new Error("Patients path is required.");
    }

    const [patientPayload, wardPayload] = await Promise.all([
      fetchJson(patientUrl, apiKey, extraHeaders, "Patients"),
      wardUrl
        ? fetchJson(wardUrl, apiKey, extraHeaders, "Wards")
        : Promise.resolve(null),
    ]);

    const rawPatients = extractArray(patientPayload, ["patients"]);
    const rawWards =
      wardPayload === null
        ? []
        : extractArray(wardPayload, ["wards", "admissions"]);

    const patientInputs = rawPatients.map((item, index) => {
      try {
        return buildPatientInput(
          mapRecord(item, patientMap),
          statusMap,
          zoneMap
        );
      } catch (err) {
        throw new Error(`Patient #${index + 1}: ${errorMessage(err)}`);
      }
    });

    const wardInputs = rawWards.map((item, index) => {
      try {
        return buildWardInput(mapRecord(item, wardMap), statusMap);
      } catch (err) {
        throw new Error(`Ward admission #${index + 1}: ${errorMessage(err)}`);
      }
    });

    const summary = await withTransaction(async (client) => {
      const patientSummary = { created: 0, updated: 0 };
      const wardSummary = { created: 0, updated: 0 };

      for (const input of patientInputs) {
        try {
          const result = await upsertPatientByExternalId(
            input,
            settings.timezone,
            client
          );
          if (result.created) patientSummary.created += 1;
          else patientSummary.updated += 1;
        } catch (err) {
          throw new Error(
            `Patient "${String(input.external_id ?? "unknown")}": ${errorMessage(err)}`
          );
        }
      }

      for (const input of wardInputs) {
        try {
          const result = await upsertWardAdmissionByExternalId(
            input,
            settings.timezone,
            client
          );
          if (result.created) wardSummary.created += 1;
          else wardSummary.updated += 1;
        } catch (err) {
          throw new Error(
            `Ward admission "${String(input.external_id ?? "unknown")}": ${errorMessage(err)}`
          );
        }
      }

      return { patients: patientSummary, wards: wardSummary };
    });

    const durationMs = Date.now() - started;
    await updateSettings({
      pms_last_sync_at: new Date().toISOString(),
      pms_last_status: "success",
      pms_last_message:
        `Patients: ${summary.patients.created} new, ${summary.patients.updated} updated | ` +
        `Wards: ${summary.wards.created} new, ${summary.wards.updated} updated`,
    });

    return { ...summary, durationMs };
  } catch (err) {
    const message = errorMessage(err).slice(0, 500);
    await updateSettings({
      pms_last_sync_at: new Date().toISOString(),
      pms_last_status: "error",
      pms_last_message: message,
    }).catch((updateErr) => {
      console.error("[pms] could not store sync error", updateErr);
    });
    throw err;
  } finally {
    running = false;
  }
}

export function startPmsScheduler(): void {
  if (timer) return;

  const tick = async (): Promise<void> => {
    if (running) return;

    try {
      const settings = await getSettings();
      if (settings.pms_enabled !== "true") return;
      if (!settings.pms_base_url.trim()) return;

      const interval =
        Math.max(10, Number.parseInt(settings.pms_interval_seconds, 10) || 30) *
        1000;
      const lastSync = Date.parse(settings.pms_last_sync_at || "") || 0;
      if (Date.now() - lastSync < interval) return;

      const result = await runPmsSync();
      console.log(
        `[pms] sync ok: patients ${result.patients.created}+/${result.patients.updated}~, ` +
          `wards ${result.wards.created}+/${result.wards.updated}~ (${result.durationMs} ms)`
      );
    } catch (err) {
      console.error(`[pms] sync failed: ${errorMessage(err)}`);
    }
  };

  timer = setInterval(() => {
    void tick();
  }, SCHEDULER_TICK_MS);
  timer.unref();
  void tick();
}

export function stopPmsScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
