import "dotenv/config";

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function trimUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

// Single-process (legacy) server and the read-only dashboard share this port.
const dashboardPort = int(process.env.PORT, 3000);
const apiPort = int(process.env.API_PORT, 4000);
const pmsPort = int(process.env.PMS_PORT, 5000);

export const config = {
  port: dashboardPort,
  apiPort,
  pmsPort,

  /** Where the dashboard server and tooling reach the management API. */
  apiBaseUrl: trimUrl(process.env.API_BASE_URL || `http://127.0.0.1:${apiPort}`),
  apiTimeoutMs: int(process.env.API_TIMEOUT_MS, 4000),

  /** Public address of the display, linked from the admin panel. */
  dashboardBaseUrl: trimUrl(
    process.env.DASHBOARD_BASE_URL || `http://127.0.0.1:${dashboardPort}`
  ),

  /** Where the API server reaches the PMS for scheduled pulls (used by pms:connect). */
  pmsBaseUrl: trimUrl(process.env.PMS_BASE_URL || `http://127.0.0.1:${pmsPort}/api`),

  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: (process.env.NODE_ENV || "development") === "production",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://eddash:eddash@localhost:5432/eddash",
  databaseSsl: bool(process.env.DATABASE_SSL),
  sessionSecret:
    process.env.SESSION_SECRET || "dev-secret-change-me-before-production",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  seedDemo: bool(process.env.SEED_DEMO),
  trustProxy: bool(process.env.TRUST_PROXY),
  pmsApiKey: process.env.PMS_API_KEY || "",

  /** Postgres schema owned by the PMS server. */
  pmsSchema: process.env.PMS_SCHEMA || "pms",
  /** Bearer token the PMS server requires on /api/*. */
  pmsServerToken: process.env.PMS_SERVER_TOKEN || "pms-local-token",
  pmsSeedDemo: bool(process.env.PMS_SEED_DEMO, true),
};

if (config.isProduction) {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set when NODE_ENV=production");
  }
  if (!process.env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD must be set when NODE_ENV=production");
  }
}
