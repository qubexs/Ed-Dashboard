import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { config } from "../config.js";
import { health } from "../db.js";
import {
  PATIENT_STATUSES,
  WARDS,
  createPatient,
  getCounts,
  listActivePatients,
  listWards,
  parseStatus,
  requestWard,
  resetDemo,
  seedDemo,
  setPatientStatus,
  setWardStatus,
  toApiPatient,
  toApiWard,
  type PmsPatient,
} from "../pms/store.js";

function tokenMatches(provided: string): boolean {
  if (!config.pmsServerToken) return true;
  const expected = Buffer.from(config.pmsServerToken);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function requirePmsToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const header = req.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || "";
  const provided = bearer || (req.get("x-api-key") || "").trim();

  if (!config.pmsServerToken || (provided && tokenMatches(provided))) {
    next();
    return;
  }

  res.status(401).json({ ok: false, error: "Invalid or missing PMS token." });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

/**
 * Patient Management System simulator (default port 5000).
 *
 * Stands in for the hospital's own system: it owns the pms.* schema, serves
 * /api/patients and /api/wards for EDDASH's pull worker, and renders a small
 * console so you can create patients and move them through triage.
 */
export function createPmsApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src", "views", "pms"));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  if (!config.isProduction) app.use(morgan("dev"));

  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(express.json({ limit: "64kb" }));
  app.use(
    express.static(path.join(process.cwd(), "public"), {
      maxAge: config.isProduction ? "1h" : 0,
    })
  );

  app.locals.formatDateTime = (value: unknown): string => {
    if (!value) return "—";
    const date = new Date(value as string);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kuala_Lumpur",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  };

  app.locals.statusLabel = (status: string): string =>
    ({
      waiting: "Waiting",
      in_treatment: "In treatment",
      waiting_ward: "Waiting ward",
      discharged: "Discharged",
      cancelled: "Cancelled",
      admitted: "Admitted",
    })[status] || status;

  const back = (suffix = ""): string => `/${suffix}`;

  app.get("/", async (_req, res, next) => {
    try {
      const [patients, wards, counts] = await Promise.all([
        listActivePatients(),
        listWards(),
        getCounts(),
      ]);

      const pendingWard = new Set(
        wards.filter((ward) => ward.status === "waiting").map((ward) => ward.patient_external_id)
      );

      res.render("console", {
        patients,
        wards,
        counts,
        pendingWard,
        wardsList: WARDS,
        statuses: PATIENT_STATUSES,
        message: String(_req.query.message || ""),
        error: String(_req.query.error || ""),
        tokenConfigured: Boolean(config.pmsServerToken),
        apiBase: config.pmsBaseUrl,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/patients", async (req, res) => {
    try {
      await createPatient({
        name: String(req.body.name || ""),
        medical_no: req.body.medical_no ? String(req.body.medical_no) : null,
        triage_level: String(req.body.triage_level || "green"),
        notes: req.body.notes ? String(req.body.notes) : null,
      });
      res.redirect(back("?message=Patient+registered"));
    } catch (err) {
      res.redirect(back(`?error=${encodeURIComponent(messageOf(err))}`));
    }
  });

  app.post("/patients/:id/status", async (req, res) => {
    try {
      const status = parseStatus(req.body.status);
      const patient = await setPatientStatus(req.params.id, status);
      if (!patient) throw new Error("Patient not found.");
      res.redirect(back(`?message=${encodeURIComponent(`${patient.name} → ${status}`)}`));
    } catch (err) {
      res.redirect(back(`?error=${encodeURIComponent(messageOf(err))}`));
    }
  });

  app.post("/patients/:id/ward", async (req, res) => {
    try {
      const ward = await requestWard(req.params.id, String(req.body.ward || ""));
      if (!ward) throw new Error("Patient not found.");
      res.redirect(back(`?message=${encodeURIComponent(`Ward request ${ward.external_id} created`)}`));
    } catch (err) {
      res.redirect(back(`?error=${encodeURIComponent(messageOf(err))}`));
    }
  });

  app.post("/wards/:id/status", async (req, res) => {
    try {
      const status = String(req.body.status || "");
      if (status !== "admitted" && status !== "cancelled") {
        throw new Error("Ward status must be admitted or cancelled.");
      }
      const ward = await setWardStatus(req.params.id, status);
      if (!ward) throw new Error("Ward request not found.");
      res.redirect(back(`?message=${encodeURIComponent(`${ward.external_id} → ${status}`)}`));
    } catch (err) {
      res.redirect(back(`?error=${encodeURIComponent(messageOf(err))}`));
    }
  });

  app.post("/simulate", async (req, res) => {
    try {
      const count = Math.min(10, Math.max(1, Number(req.body.count) || 5));
      const created = await seedDemo(count);
      res.redirect(back(`?message=${created}+patients+arrived`));
    } catch (err) {
      res.redirect(back(`?error=${encodeURIComponent(messageOf(err))}`));
    }
  });

  app.post("/reset", async (_req, res) => {
    try {
      await resetDemo();
      const created = config.pmsSeedDemo ? await seedDemo(30) : 0;
      res.redirect(back(`?message=Reset+complete,+${created}+demo+patients+seeded`));
    } catch (err) {
      res.redirect(back(`?error=${encodeURIComponent(messageOf(err))}`));
    }
  });

  // ---- API consumed by the EDDASH pull worker -----------------------------

  app.get("/api/patients", requirePmsToken, async (_req, res, next) => {
    try {
      const patients = await listActivePatients();
      res.set("Cache-Control", "no-store").json({
        generated_at: new Date().toISOString(),
        patients: patients.map(toApiPatient),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/wards", requirePmsToken, async (_req, res, next) => {
    try {
      const wards = await listWards();
      res.set("Cache-Control", "no-store").json({
        generated_at: new Date().toISOString(),
        wards: wards
          .filter((ward) => ward.status !== "cancelled")
          .map(toApiWard),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/health", async (_req, res) => {
    try {
      const [database, counts] = await Promise.all([health(), getCounts()]);
      res.json({
        status: "ok",
        server: "pms",
        database,
        counts,
      });
    } catch (err) {
      res.status(503).json({ status: "error", server: "pms", error: messageOf(err) });
    }
  });

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    res.status(404).type("text/plain").send("Not found");
  });

  app.use(
    (
      err: Error,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error(`[pms] ${req.method} ${req.originalUrl}`, err);
      if (req.path.startsWith("/api/")) {
        res.status(500).json({ ok: false, error: "Internal server error" });
        return;
      }
      res.status(500).type("text/plain").send("Internal server error");
    }
  );

  return app;
}

export type { PmsPatient };
