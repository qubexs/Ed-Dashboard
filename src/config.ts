import "dotenv/config";

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export const config = {
  port: Number(process.env.PORT || 3000),
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
};

if (config.isProduction) {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set when NODE_ENV=production");
  }
  if (!process.env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD must be set when NODE_ENV=production");
  }
}
