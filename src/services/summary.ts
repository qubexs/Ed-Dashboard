import { query } from "../db.js";
import { getSettings } from "./settings.js";

function toInt(value: string | undefined, fallback = 0): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface ZoneSummary {
  code: string;
  name: string;
  name_en: string | null;
  color: string;
  count: number;
}

export interface DashboardMeta {
  timezone: string;
  refreshSeconds: number;
  generatedAt: string;
}

export interface DashboardData {
  meta: DashboardMeta;
  waitingTimeMinutes: number;
  waitingPatients: number;
  totalSinceMidnight: number;
  wardWaitingMinutes: number;
  wardWaitingPatients: number;
  zones: ZoneSummary[];
}

export interface AdminStats {
  active: number;
  waiting: number;
  today: number;
  total: number;
  zones: number;
  wardWaiting: number;
}

interface WaitingRow {
  count: number;
  avg_minutes: number;
}

interface CountRow {
  count: number;
}

interface ZoneRow {
  code: string;
  name: string;
  name_en: string | null;
  color: string;
  count: number;
}

export async function getDashboardData(): Promise<DashboardData> {
  const settings = await getSettings();
  const timezone = settings.timezone || "Asia/Kuala_Lumpur";

  const [waitingResult, totalResult, wardResult, zoneResult] = await Promise.all([
    query<WaitingRow>(
      `SELECT COUNT(*)::int AS count,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (now() - arrived_at)) / 60)), 0)::int AS avg_minutes
         FROM patients
        WHERE status = 'waiting'`
    ),
    query<CountRow>(
      `SELECT COUNT(*)::int AS count
         FROM patients
        WHERE arrived_at >= (date_trunc('day', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text)`,
      [timezone]
    ),
    query<WaitingRow>(
      `SELECT COUNT(*)::int AS count,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (now() - requested_at)) / 60)), 0)::int AS avg_minutes
         FROM ward_admissions
        WHERE status = 'waiting'`
    ),
    query<ZoneRow>(
      `SELECT z.code, z.name, z.name_en, z.color,
              COUNT(p.id) FILTER (
                WHERE p.status IN ('waiting', 'in_treatment', 'waiting_ward')
              )::int AS count
         FROM zones z
         LEFT JOIN patients p ON p.zone_code = z.code
        WHERE z.active = true
        GROUP BY z.code, z.name, z.name_en, z.color, z.sort_order
        ORDER BY z.sort_order, z.code`
    ),
  ]);

  const waitingCount = waitingResult.rows[0].count;
  const waitingAverage = waitingResult.rows[0].avg_minutes;
  const buffer = toInt(settings.waiting_buffer_minutes);
  const fallback = toInt(settings.waiting_fallback_minutes);

  const waitingTimeMinutes =
    waitingCount > 0
      ? Math.max(0, waitingAverage + buffer)
      : Math.max(0, fallback);

  return {
    meta: {
      timezone,
      refreshSeconds: Math.min(300, Math.max(5, toInt(settings.refresh_seconds, 10))),
      generatedAt: new Date().toISOString(),
    },
    waitingTimeMinutes,
    waitingPatients: waitingCount,
    totalSinceMidnight: totalResult.rows[0].count,
    wardWaitingMinutes: wardResult.rows[0].avg_minutes,
    wardWaitingPatients: wardResult.rows[0].count,
    zones: zoneResult.rows,
  };
}

export async function getAdminStats(): Promise<AdminStats> {
  const settings = await getSettings();
  const timezone = settings.timezone || "Asia/Kuala_Lumpur";

  const [stats, zones, ward] = await Promise.all([
    query<{
      active: number;
      waiting: number;
      today: number;
      total: number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('waiting', 'in_treatment', 'waiting_ward'))::int AS active,
         COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
         COUNT(*) FILTER (
           WHERE arrived_at >= (date_trunc('day', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text)
         )::int AS today,
         COUNT(*)::int AS total
       FROM patients`,
      [timezone]
    ),
    query<CountRow>("SELECT COUNT(*)::int AS count FROM zones WHERE active = true"),
    query<CountRow>(
      "SELECT COUNT(*)::int AS count FROM ward_admissions WHERE status = 'waiting'"
    ),
  ]);

  return {
    active: stats.rows[0].active,
    waiting: stats.rows[0].waiting,
    today: stats.rows[0].today,
    total: stats.rows[0].total,
    zones: zones.rows[0].count,
    wardWaiting: ward.rows[0].count,
  };
}
