import express from "express";
import bcrypt from "bcryptjs";
import pool, { health } from "../db.js";
import { config } from "../config.js";
import { getAdminStats, getDashboardData } from "../services/summary.js";
import {
  getSettings,
  updateSettings,
  isValidTimezone,
} from "../services/settings.js";
import { requireAdmin, setFlash } from "../middleware/auth.js";
import {
  PATIENT_STATUSES,
  statusTimestamps,
} from "../services/patients.js";
import { generateApiKey } from "../services/apiKeys.js";
import { isPmsSyncRunning, runPmsSync } from "../services/pms.js";
import {
  asyncHandler,
  clampInt,
  isHexColor,
  safeZoneColor,
} from "../utils/helpers.js";
import { dateToZonedInput, zonedInputToDate } from "../utils/datetime.js";

const router = express.Router();

const STATUSES: string[] = [...PATIENT_STATUSES];
const ROLES: string[] = ["admin", "viewer"];

interface ZoneRecord {
  code: string;
  name: string;
  name_en: string | null;
  color: string;
  sort_order: number;
  active: boolean;
}

interface PatientRecord {
  id: number;
  medical_no: string | null;
  name: string | null;
  zone_code: string | null;
  status: string;
  arrived_at: Date;
  triaged_at: Date | null;
  called_at: Date | null;
  discharged_at: Date | null;
  notes: string | null;
}

interface PatientListRow extends PatientRecord {
  zone_name: string | null;
  zone_color: string | null;
  waited_minutes: number;
}

interface WardRow {
  id: number;
  patient_id: number | null;
  patient_name: string | null;
  ward: string | null;
  status: string;
  requested_at: Date;
  admitted_at: Date | null;
  patient_display_name: string | null;
  medical_no: string | null;
  waited_minutes: number;
}

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  last_used_at: Date | null;
  created_at: Date;
}

function flashError(req: express.Request, message: string): void {
  setFlash(req, "error", message);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidStringMap(value: string): boolean {
  const text = String(value || "").trim();
  if (!text) return true;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Object.values(parsed as Record<string, unknown>).every(
      (item) => typeof item === "string"
    );
  } catch {
    return false;
  }
}

async function getZones(onlyActive = false): Promise<ZoneRecord[]> {
  const { rows } = await pool.query<ZoneRecord>(
    `SELECT * FROM zones ${onlyActive ? "WHERE active = true" : ""} ORDER BY sort_order, code`
  );
  return rows;
}

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [stats, data, recent, users, settings] = await Promise.all([
      getAdminStats(),
      getDashboardData(),
      pool.query<{
        id: number;
        name: string | null;
        medical_no: string | null;
        status: string;
        arrived_at: Date;
        zone_name: string | null;
        zone_color: string | null;
      }>(
        `SELECT p.id, p.name, p.medical_no, p.status, p.arrived_at, z.name AS zone_name, z.color AS zone_color
           FROM patients p LEFT JOIN zones z ON z.code = p.zone_code
          ORDER BY p.arrived_at DESC LIMIT 8`
      ),
      pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM users"),
      getSettings(),
    ]);

    let dbHealth;
    try {
      dbHealth = await health();
    } catch (err) {
      dbHealth = { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
    }

    res.render("admin/index", {
      page: "overview",
      stats,
      data: {
        ...data,
        zones: data.zones.map((zone) => ({
          ...zone,
          color: safeZoneColor(zone.color),
        })),
      },
      recent: recent.rows,
      userCount: users.rows[0].count,
      dbHealth,
      timezone: settings.timezone,
    });
  })
);

router.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    res.render("admin/settings", { page: "settings", settings });
  })
);

router.post(
  "/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body;

    const timezone = String(body.timezone || "").trim();
    if (!isValidTimezone(timezone)) {
      flashError(req, "Timezone must be a valid IANA name, e.g. Asia/Kuala_Lumpur.");
      res.redirect("/admin/settings");
      return;
    }

    const refresh = clampInt(body.refresh_seconds, 5, 300, 10);
    const buffer = clampInt(body.waiting_buffer_minutes, 0, 600, 0);
    const fallback = clampInt(body.waiting_fallback_minutes, 0, 600, 0);

    await updateSettings({
      hospital_name: String(body.hospital_name || "").trim().slice(0, 120),
      hospital_subtitle: String(body.hospital_subtitle || "").trim().slice(0, 240),
      logo_url: String(body.logo_url || "").trim().slice(0, 500),
      footer_message: String(body.footer_message || "").trim().slice(0, 300),
      footer_message_en: String(body.footer_message_en || "").trim().slice(0, 300),
      qr_url: String(body.qr_url || "").trim().slice(0, 500),
      qr_caption: String(body.qr_caption || "").trim().slice(0, 200),
      timezone,
      refresh_seconds: String(refresh),
      waiting_buffer_minutes: String(buffer),
      waiting_fallback_minutes: String(fallback),
    });

    setFlash(req, "success", "Display settings saved.");
    res.redirect("/admin/settings");
  })
);

router.get(
  "/zones",
  asyncHandler(async (_req, res) => {
    const zones = await getZones();
    res.render("admin/zones", { page: "zones", zones });
  })
);

router.post(
  "/zones",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const code = String(req.body.code || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(code)) {
      flashError(req, "Zone code must be 2-32 characters: a-z, 0-9, _ or -.");
      res.redirect("/admin/zones");
      return;
    }
    const name = String(req.body.name || "").trim().slice(0, 80);
    if (!name) {
      flashError(req, "Zone name is required.");
      res.redirect("/admin/zones");
      return;
    }
    const color = isHexColor(req.body.color) ? String(req.body.color) : "#5FE3D6";
    const sortOrder = clampInt(req.body.sort_order, 0, 999, 99);

    try {
      await pool.query(
        "INSERT INTO zones (code, name, name_en, color, sort_order) VALUES ($1, $2, $3, $4, $5)",
        [code, name, String(req.body.name_en || "").trim().slice(0, 80), color, sortOrder]
      );
      setFlash(req, "success", `Zone "${code}" created.`);
    } catch (err) {
      const code23505 = (err as { code?: string }).code === "23505";
      flashError(req, code23505 ? "That zone code already exists." : "Could not create zone.");
    }
    res.redirect("/admin/zones");
  })
);

router.post(
  "/zones/:code",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const code = String(req.params.code);
    const name = String(req.body.name || "").trim().slice(0, 80);
    if (!name) {
      flashError(req, "Zone name is required.");
      res.redirect("/admin/zones");
      return;
    }
    await pool.query(
      `UPDATE zones
          SET name = $2, name_en = $3, color = $4, sort_order = $5, active = $6
        WHERE code = $1`,
      [
        code,
        name,
        String(req.body.name_en || "").trim().slice(0, 80),
        isHexColor(req.body.color) ? String(req.body.color) : "#5FE3D6",
        clampInt(req.body.sort_order, 0, 999, 99),
        req.body.active === "on",
      ]
    );
    setFlash(req, "success", `Zone "${code}" updated.`);
    res.redirect("/admin/zones");
  })
);

router.post(
  "/zones/:code/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const code = String(req.params.code);
    const { rows } = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM patients WHERE zone_code = $1",
      [code]
    );
    if (rows[0].count > 0) {
      flashError(
        req,
        `Zone "${code}" still has ${rows[0].count} patient record(s). Deactivate it instead.`
      );
      res.redirect("/admin/zones");
      return;
    }
    await pool.query("DELETE FROM zones WHERE code = $1", [code]);
    setFlash(req, "success", `Zone "${code}" deleted.`);
    res.redirect("/admin/zones");
  })
);

router.get(
  "/patients",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim();
    const status =
      typeof req.query.status === "string" && STATUSES.includes(req.query.status)
        ? req.query.status
        : "";
    const zone = String(req.query.zone || "").trim();

    const where: string[] = [];
    const params: any[] = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`(p.name ILIKE $${params.length} OR p.medical_no ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      where.push(`p.status = $${params.length}`);
    }
    if (zone) {
      params.push(zone);
      where.push(`p.zone_code = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [{ rows: patients }, zones, settings] = await Promise.all([
      pool.query<PatientListRow>(
        `SELECT p.*, z.name AS zone_name, z.color AS zone_color,
                ROUND(EXTRACT(EPOCH FROM (now() - p.arrived_at)) / 60)::int AS waited_minutes
           FROM patients p
           LEFT JOIN zones z ON z.code = p.zone_code
           ${whereSql}
          ORDER BY p.arrived_at DESC
          LIMIT 200`,
        params
      ),
      getZones(),
      getSettings(),
    ]);

    res.render("admin/patients", {
      page: "patients",
      patients,
      zones,
      statuses: STATUSES,
      filters: { q, status, zone },
      timezone: settings.timezone,
    });
  })
);

router.get(
  "/patients/new",
  asyncHandler(async (_req, res) => {
    const [zones, settings] = await Promise.all([getZones(true), getSettings()]);
    res.render("admin/patient-form", {
      page: "patients",
      patient: null,
      zones,
      statuses: STATUSES,
      arrivedInput: "",
      timezone: settings.timezone,
    });
  })
);

router.post(
  "/patients",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const name = String(req.body.name || "").trim().slice(0, 120);
    const medicalNo = String(req.body.medical_no || "").trim().slice(0, 60);
    const zone = String(req.body.zone_code || "").trim();
    const status = STATUSES.includes(req.body.status) ? req.body.status : "waiting";
    const notes = String(req.body.notes || "").trim().slice(0, 500);

    if (!name && !medicalNo) {
      flashError(req, "Enter a patient name or medical number.");
      res.redirect("/admin/patients/new");
      return;
    }
    if (!zone) {
      flashError(req, "Select a triage zone.");
      res.redirect("/admin/patients/new");
      return;
    }

    const arrivedAt =
      zonedInputToDate(req.body.arrived_at, settings.timezone) || new Date();
    const now = new Date();
    const stamps = statusTimestamps(status, {
      triaged_at: now,
      called_at: null,
      discharged_at: null,
    });

    await pool.query(
      `INSERT INTO patients
         (medical_no, name, zone_code, status, arrived_at, triaged_at, called_at, discharged_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        medicalNo || null,
        name || null,
        zone,
        status,
        arrivedAt,
        now,
        stamps.called_at,
        stamps.discharged_at,
        notes || null,
      ]
    );

    setFlash(req, "success", "Patient added to the queue.");
    res.redirect("/admin/patients");
  })
);

router.get(
  "/patients/:id/edit",
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const { rows } = await pool.query<PatientRecord>(
      "SELECT * FROM patients WHERE id = $1",
      [req.params.id]
    );
    const patient = rows[0];
    if (!patient) {
      flashError(req, "Patient not found.");
      res.redirect("/admin/patients");
      return;
    }
    const zones = await getZones(true);
    res.render("admin/patient-form", {
      page: "patients",
      patient,
      zones,
      statuses: STATUSES,
      arrivedInput: dateToZonedInput(patient.arrived_at, settings.timezone),
      timezone: settings.timezone,
    });
  })
);

router.post(
  "/patients/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const { rows } = await pool.query<PatientRecord>(
      "SELECT * FROM patients WHERE id = $1",
      [req.params.id]
    );
    const patient = rows[0];
    if (!patient) {
      flashError(req, "Patient not found.");
      res.redirect("/admin/patients");
      return;
    }

    const name = String(req.body.name || "").trim().slice(0, 120);
    const medicalNo = String(req.body.medical_no || "").trim().slice(0, 60);
    const zone = String(req.body.zone_code || "").trim();
    const status = STATUSES.includes(req.body.status) ? req.body.status : patient.status;
    const notes = String(req.body.notes || "").trim().slice(0, 500);

    if (!name && !medicalNo) {
      flashError(req, "Enter a patient name or medical number.");
      res.redirect(`/admin/patients/${patient.id}/edit`);
      return;
    }
    if (!zone) {
      flashError(req, "Select a triage zone.");
      res.redirect(`/admin/patients/${patient.id}/edit`);
      return;
    }

    const arrivedAt =
      zonedInputToDate(req.body.arrived_at, settings.timezone) || patient.arrived_at;
    const stamps = statusTimestamps(status, patient);

    await pool.query(
      `UPDATE patients
          SET medical_no = $2, name = $3, zone_code = $4, status = $5,
              arrived_at = $6, triaged_at = COALESCE($7, triaged_at),
              called_at = $8, discharged_at = $9, notes = $10, updated_at = now()
        WHERE id = $1`,
      [
        patient.id,
        medicalNo || null,
        name || null,
        zone,
        status,
        arrivedAt,
        patient.triaged_at,
        stamps.called_at,
        stamps.discharged_at,
        notes || null,
      ]
    );

    if (["discharged", "cancelled"].includes(status)) {
      await pool.query(
        "UPDATE ward_admissions SET status = 'cancelled', updated_at = now() WHERE patient_id = $1 AND status = 'waiting'",
        [patient.id]
      );
    }

    setFlash(req, "success", "Patient updated.");
    res.redirect("/admin/patients");
  })
);

router.post(
  "/patients/:id/status",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<PatientRecord>(
      "SELECT * FROM patients WHERE id = $1",
      [req.params.id]
    );
    const patient = rows[0];
    if (!patient) {
      flashError(req, "Patient not found.");
      res.redirect("/admin/patients");
      return;
    }
    const status = STATUSES.includes(req.body.status) ? req.body.status : null;
    if (!status) {
      flashError(req, "Unknown status.");
      res.redirect("/admin/patients");
      return;
    }

    const stamps = statusTimestamps(status, patient);
    await pool.query(
      `UPDATE patients
          SET status = $2, called_at = $3, discharged_at = $4, updated_at = now()
        WHERE id = $1`,
      [patient.id, status, stamps.called_at, stamps.discharged_at]
    );

    if (["discharged", "cancelled"].includes(status)) {
      await pool.query(
        "UPDATE ward_admissions SET status = 'cancelled', updated_at = now() WHERE patient_id = $1 AND status = 'waiting'",
        [patient.id]
      );
    }

    setFlash(req, "success", "Status updated.");
    res.redirect(req.body.redirect || "/admin/patients");
  })
);

router.post(
  "/patients/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await pool.query("DELETE FROM patients WHERE id = $1", [req.params.id]);
    setFlash(req, "success", "Patient record deleted.");
    res.redirect("/admin/patients");
  })
);

router.get(
  "/wards",
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    const [{ rows: admissions }, { rows: candidates }] = await Promise.all([
      pool.query<WardRow>(
        `SELECT w.*, p.medical_no, p.name AS patient_display_name,
                ROUND(EXTRACT(EPOCH FROM (now() - w.requested_at)) / 60)::int AS waited_minutes
           FROM ward_admissions w
           LEFT JOIN patients p ON p.id = w.patient_id
          ORDER BY (w.status = 'waiting') DESC, w.requested_at ASC
          LIMIT 200`
      ),
      pool.query<{ id: number; name: string | null; medical_no: string | null }>(
        `SELECT id, name, medical_no FROM patients
          WHERE status IN ('waiting', 'in_treatment', 'waiting_ward')
          ORDER BY arrived_at ASC LIMIT 100`
      ),
    ]);

    res.render("admin/wards", {
      page: "wards",
      admissions,
      candidates,
      timezone: settings.timezone,
    });
  })
);

router.post(
  "/wards",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const patientId = req.body.patient_id ? Number(req.body.patient_id) : null;
    let patient: PatientRecord | undefined;

    if (patientId) {
      const { rows } = await pool.query<PatientRecord>(
        "SELECT * FROM patients WHERE id = $1",
        [patientId]
      );
      patient = rows[0];
      if (!patient) {
        flashError(req, "Selected patient was not found.");
        res.redirect("/admin/wards");
        return;
      }
      const existing = await pool.query(
        "SELECT 1 FROM ward_admissions WHERE patient_id = $1 AND status = 'waiting'",
        [patientId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        flashError(req, "This patient already has a pending ward admission.");
        res.redirect("/admin/wards");
        return;
      }
    }

    const patientName =
      String(req.body.patient_name || "").trim().slice(0, 120) || patient?.name || null;
    if (!patientId && !patientName) {
      flashError(req, "Choose a patient or enter a patient name.");
      res.redirect("/admin/wards");
      return;
    }

    const requestedAt =
      zonedInputToDate(req.body.requested_at, settings.timezone) || new Date();
    const ward = String(req.body.ward || "").trim().slice(0, 80) || null;

    await pool.query(
      `INSERT INTO ward_admissions (patient_id, patient_name, ward, status, requested_at)
       VALUES ($1, $2, $3, 'waiting', $4)`,
      [patientId, patient?.name || patientName, ward, requestedAt]
    );

    if (patient && ["waiting", "in_treatment"].includes(patient.status)) {
      await pool.query(
        "UPDATE patients SET status = 'waiting_ward', updated_at = now() WHERE id = $1",
        [patient.id]
      );
    }

    setFlash(req, "success", "Ward admission requested.");
    res.redirect("/admin/wards");
  })
);

router.post(
  "/wards/:id/admit",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ward = String(req.body.ward || "").trim().slice(0, 80) || null;
    await pool.query(
      `UPDATE ward_admissions
          SET status = 'admitted', ward = COALESCE($2, ward), admitted_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'waiting'`,
      [req.params.id, ward]
    );
    setFlash(req, "success", "Patient marked as admitted.");
    res.redirect("/admin/wards");
  })
);

router.post(
  "/wards/:id/cancel",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await pool.query(
      "UPDATE ward_admissions SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'waiting'",
      [req.params.id]
    );
    setFlash(req, "success", "Ward request cancelled.");
    res.redirect("/admin/wards");
  })
);

router.post(
  "/wards/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await pool.query("DELETE FROM ward_admissions WHERE id = $1", [req.params.id]);
    setFlash(req, "success", "Ward admission deleted.");
    res.redirect("/admin/wards");
  })
);

router.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query<{
      id: number;
      username: string;
      role: string;
      created_at: Date;
    }>("SELECT id, username, role, created_at FROM users ORDER BY id");
    const settings = await getSettings();
    res.render("admin/users", {
      page: "users",
      users: rows,
      roles: ROLES,
      timezone: settings.timezone,
    });
  })
);

router.post(
  "/users",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const role = ROLES.includes(req.body.role) ? req.body.role : "viewer";

    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      flashError(req, "Username must be 3-32 characters: letters, numbers, . _ -");
      res.redirect("/admin/users");
      return;
    }
    if (password.length < 8) {
      flashError(req, "Password must be at least 8 characters.");
      res.redirect("/admin/users");
      return;
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)",
        [username, hash, role]
      );
      setFlash(req, "success", `User "${username}" created.`);
    } catch (err) {
      const code23505 = (err as { code?: string }).code === "23505";
      flashError(req, code23505 ? "That username is already taken." : "Could not create user.");
    }
    res.redirect("/admin/users");
  })
);

router.post(
  "/users/:id/password",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const password = String(req.body.password || "");
    if (password.length < 8) {
      flashError(req, "Password must be at least 8 characters.");
      res.redirect("/admin/users");
      return;
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1",
      [req.params.id, hash]
    );
    setFlash(req, "success", "Password updated.");
    res.redirect("/admin/users");
  })
);

router.post(
  "/users/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.session.user?.id) {
      flashError(req, "You cannot delete your own account.");
      res.redirect("/admin/users");
      return;
    }
    const target = await pool.query<{ role: string }>(
      "SELECT role FROM users WHERE id = $1",
      [id]
    );
    if (target.rows[0]?.role === "admin") {
      const admins = await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'"
      );
      if (admins.rows[0].count <= 1) {
        flashError(req, "At least one admin account must remain.");
        res.redirect("/admin/users");
        return;
      }
    }
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    setFlash(req, "success", "User deleted.");
    res.redirect("/admin/users");
  })
);

router.post(
  "/password",
  asyncHandler(async (req, res) => {
    const current = String(req.body.current_password || "");
    const next = String(req.body.new_password || "");
    const confirm = String(req.body.confirm_password || "");

    if (next.length < 8) {
      flashError(req, "New password must be at least 8 characters.");
      res.redirect("/admin/users");
      return;
    }
    if (next !== confirm) {
      flashError(req, "New password and confirmation do not match.");
      res.redirect("/admin/users");
      return;
    }

    const userId = req.session.user?.id;
    const { rows } = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [userId]
    );
    const valid = rows[0] ? await bcrypt.compare(current, rows[0].password_hash) : false;
    if (!valid) {
      flashError(req, "Current password is incorrect.");
      res.redirect("/admin/users");
      return;
    }

    const hash = await bcrypt.hash(next, 12);
    await pool.query(
      "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1",
      [userId, hash]
    );
    setFlash(req, "success", "Your password has been changed.");
    res.redirect("/admin/users");
  })
);

router.get(
  "/integration",
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    res.render("admin/integration", {
      page: "integration",
      settings: { ...settings, pms_api_key: "" },
      apiKeyFromEnv: Boolean(config.pmsApiKey),
      apiKeySet: Boolean(config.pmsApiKey || settings.pms_api_key),
      running: isPmsSyncRunning(),
    });
  })
);

router.post(
  "/integration",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const current = await getSettings();

    const enabled = req.body.pms_enabled === "on";
    const baseUrl = String(req.body.pms_base_url || "").trim().slice(0, 500);
    const patientsPath =
      String(req.body.pms_patients_path || "").trim().slice(0, 500) ||
      "/patients";
    const wardsPath = String(req.body.pms_wards_path || "").trim().slice(0, 500);
    const interval = clampInt(req.body.pms_interval_seconds, 10, 3600, 30);

    const maps = {
      pms_patient_map: String(req.body.pms_patient_map || "").trim().slice(0, 20_000),
      pms_ward_map: String(req.body.pms_ward_map || "").trim().slice(0, 20_000),
      pms_status_map: String(req.body.pms_status_map || "").trim().slice(0, 20_000),
      pms_zone_map: String(req.body.pms_zone_map || "").trim().slice(0, 20_000),
      pms_headers: String(req.body.pms_headers || "").trim().slice(0, 20_000),
    };

    if (baseUrl && !isHttpUrl(baseUrl)) {
      flashError(req, "PMS base URL must start with http:// or https://.");
      res.redirect("/admin/integration");
      return;
    }
    if (enabled && !baseUrl) {
      flashError(req, "Enter the PMS base URL before enabling the integration.");
      res.redirect("/admin/integration");
      return;
    }
    if (enabled && !patientsPath && !wardsPath) {
      flashError(req, "Enter at least one endpoint path.");
      res.redirect("/admin/integration");
      return;
    }

    const mapLabels: Record<string, string> = {
      pms_patient_map: "Patient field map",
      pms_ward_map: "Ward field map",
      pms_status_map: "Status map",
      pms_zone_map: "Zone map",
      pms_headers: "Extra headers",
    };
    for (const [key, label] of Object.entries(mapLabels)) {
      if (!isValidStringMap(maps[key as keyof typeof maps])) {
        flashError(req, `${label} must be a JSON object with string values.`);
        res.redirect("/admin/integration");
        return;
      }
    }

    const apiKeyInput = String(req.body.pms_api_key || "").trim();
    const clearApiKey = req.body.pms_clear_api_key === "on";
    let apiKey = current.pms_api_key;
    if (apiKeyInput) apiKey = apiKeyInput.slice(0, 500);
    else if (clearApiKey) apiKey = "";

    await updateSettings({
      ...maps,
      pms_enabled: enabled ? "true" : "false",
      pms_base_url: baseUrl,
      pms_api_key: apiKey,
      pms_patients_path: patientsPath,
      pms_wards_path: wardsPath,
      pms_interval_seconds: String(interval),
    });

    setFlash(req, "success", "PMS integration settings saved.");
    res.redirect("/admin/integration");
  })
);

router.post(
  "/integration/sync",
  requireAdmin,
  asyncHandler(async (req, res) => {
    try {
      const result = await runPmsSync();
      setFlash(
        req,
        "success",
        `Sync complete: patients ${result.patients.created} new / ${result.patients.updated} updated, ` +
          `wards ${result.wards.created} new / ${result.wards.updated} updated (${result.durationMs} ms).`
      );
    } catch (err) {
      setFlash(
        req,
        "error",
        `Sync failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
    res.redirect("/admin/integration");
  })
);

router.get(
  "/api-keys",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query<ApiKeyRow>(
      `SELECT id, name, prefix, last_used_at, created_at
         FROM api_keys
        ORDER BY created_at DESC`
    );
    const settings = await getSettings();
    res.render("admin/api-keys", {
      page: "api-keys",
      keys: rows,
      newKey: null,
      timezone: settings.timezone,
    });
  })
);

router.post(
  "/api-keys",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const name =
      String(req.body.name || "").trim().slice(0, 80) || "Integration key";
    const generated = generateApiKey();

    await pool.query(
      "INSERT INTO api_keys (name, prefix, key_hash) VALUES ($1, $2, $3)",
      [name, generated.prefix, generated.hash]
    );

    const [{ rows }, settings] = await Promise.all([
      pool.query<ApiKeyRow>(
        `SELECT id, name, prefix, last_used_at, created_at
           FROM api_keys
          ORDER BY created_at DESC`
      ),
      getSettings(),
    ]);

    res.render("admin/api-keys", {
      page: "api-keys",
      keys: rows,
      newKey: generated.key,
      timezone: settings.timezone,
    });
  })
);

router.post(
  "/api-keys/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await pool.query("DELETE FROM api_keys WHERE id = $1", [req.params.id]);
    setFlash(req, "success", "API key revoked.");
    res.redirect("/admin/api-keys");
  })
);

router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    let dbHealth;
    try {
      dbHealth = await health();
    } catch (err) {
      dbHealth = { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
    }

    const counts = await pool.query<{
      patients: number;
      admissions: number;
      zones: number;
      users: number;
      apiKeys: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM patients) AS patients,
         (SELECT COUNT(*)::int FROM ward_admissions) AS admissions,
         (SELECT COUNT(*)::int FROM zones) AS zones,
         (SELECT COUNT(*)::int FROM users) AS users,
         (SELECT COUNT(*)::int FROM api_keys) AS "apiKeys"`
    );

    res.render("admin/health", {
      page: "health",
      dbHealth,
      counts: counts.rows[0],
      settings,
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
    });
  })
);

export default router;
