import express from "express";
import type { PoolClient } from "pg";
import pool from "../db.js";
import { requireApiKey } from "../middleware/apiKey.js";
import { getSettings } from "../services/settings.js";
import {
  upsertPatientByExternalId,
  type PatientUpsertInput,
} from "../services/patients.js";
import {
  upsertWardAdmissionByExternalId,
  type WardUpsertInput,
} from "../services/wards.js";
import { ApiError } from "../utils/apiError.js";
import { asyncHandler } from "../utils/helpers.js";

const router = express.Router();

router.use(requireApiKey);

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

function ensureObject(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be a JSON object.`);
  }
}

router.get("/ping", (_req, res) => {
  const apiKey = res.locals.apiKey as { name: string; prefix: string };
  res.json({
    ok: true,
    key: apiKey.name,
    prefix: apiKey.prefix,
    time: new Date().toISOString(),
  });
});

router.post(
  "/patients",
  asyncHandler(async (req, res) => {
    ensureObject(req.body, "body");
    const timezone = (await getSettings()).timezone;

    const result = await withTransaction((client) =>
      upsertPatientByExternalId(req.body as PatientUpsertInput, timezone, client)
    );

    res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      patient: result.patient,
    });
  })
);

router.post(
  "/wards",
  asyncHandler(async (req, res) => {
    ensureObject(req.body, "body");
    const timezone = (await getSettings()).timezone;

    const result = await withTransaction((client) =>
      upsertWardAdmissionByExternalId(
        req.body as WardUpsertInput,
        timezone,
        client
      )
    );

    res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      admission: result.admission,
    });
  })
);

router.post(
  "/sync",
  asyncHandler(async (req, res) => {
    ensureObject(req.body, "body");

    const body = req.body as { patients?: unknown; wards?: unknown };
    const patients = body.patients ?? [];
    const wards = body.wards ?? [];

    if (!Array.isArray(patients) || !Array.isArray(wards)) {
      throw new ApiError(400, "patients and wards must be arrays.");
    }
    if (patients.length + wards.length === 0) {
      throw new ApiError(
        400,
        "Provide at least one record in patients or wards."
      );
    }
    if (patients.length + wards.length > 1000) {
      throw new ApiError(400, "A sync is limited to 1000 records.");
    }

    patients.forEach((item, index) =>
      ensureObject(item, `patients[${index}]`)
    );
    wards.forEach((item, index) => ensureObject(item, `wards[${index}]`));

    const timezone = (await getSettings()).timezone;

    const summary = await withTransaction(async (client) => {
      const patientSummary = { created: 0, updated: 0 };
      const wardSummary = { created: 0, updated: 0 };

      for (const item of patients) {
        const result = await upsertPatientByExternalId(
          item as PatientUpsertInput,
          timezone,
          client
        );
        if (result.created) patientSummary.created += 1;
        else patientSummary.updated += 1;
      }

      for (const item of wards) {
        const result = await upsertWardAdmissionByExternalId(
          item as WardUpsertInput,
          timezone,
          client
        );
        if (result.created) wardSummary.created += 1;
        else wardSummary.updated += 1;
      }

      return { patients: patientSummary, wards: wardSummary };
    });

    res.json({ ok: true, ...summary });
  })
);

export default router;
