import express from "express";

import { requireApiKey } from "../middleware/apiKey.js";
import { ApiError } from "../utils/apiError.js";
import { asyncHandler, clampInt } from "../utils/helpers.js";
import { health } from "../db.js";
import { getDashboardData } from "../services/summary.js";
import { getPublicSettings } from "../services/publicConfig.js";
import {
  getPatient,
  getStats,
  listPatients,
  listWards,
  listZones,
} from "../services/provider.js";

const router = express.Router();

// Every /api/v1 endpoint requires an API key created in Admin > API keys.
router.use(requireApiKey);

function paging(req: express.Request): { limit: number; offset: number } {
  return {
    limit: clampInt(req.query.limit, 1, 500, 100),
    offset: clampInt(req.query.offset, 0, 1_000_000, 0),
  };
}

function single(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Key identity + server clock. Useful for connectivity checks. */
router.get("/ping", (_req, res) => {
  const apiKey = res.locals.apiKey as { name: string; prefix: string };
  res.json({
    ok: true,
    server: "eddash-api",
    version: 1,
    key: apiKey.name,
    prefix: apiKey.prefix,
    time: new Date().toISOString(),
  });
});

router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    try {
      const database = await health();
      res.json({ ok: true, status: "ok", database });
    } catch (err) {
      res.status(503).json({
        ok: false,
        status: "error",
        error: err instanceof Error ? err.message : "Database unavailable",
      });
    }
  })
);

/** The same payload the waiting-room display renders. */
router.get(
  "/dashboard",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...(await getDashboardData()) });
  })
);

/** Queue totals for dashboards or monitoring. */
router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, stats: await getStats() });
  })
);

router.get(
  "/patients",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paging(req);
    const result = await listPatients({
      status: single(req.query.status),
      zone: single(req.query.zone),
      limit,
      offset,
    });

    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      total: result.total,
      count: result.items.length,
      limit,
      offset,
      patients: result.items,
    });
  })
);

router.get(
  "/patients/:id",
  asyncHandler(async (req, res) => {
    const patient = await getPatient(req.params.id);
    if (!patient) {
      throw new ApiError(404, `Patient "${req.params.id}" was not found.`);
    }
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, patient });
  })
);

router.get(
  "/wards",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paging(req);
    const result = await listWards({
      status: single(req.query.status),
      limit,
      offset,
    });

    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      total: result.total,
      count: result.items.length,
      limit,
      offset,
      wards: result.items,
    });
  })
);

router.get(
  "/zones",
  asyncHandler(async (_req, res) => {
    const zones = await listZones();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, count: zones.length, zones });
  })
);

/** Public display settings, without integration secrets. */
router.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, settings: await getPublicSettings() });
  })
);

export default router;
