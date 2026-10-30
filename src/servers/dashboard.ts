import { createDashboardApp } from "../apps/dashboard.js";
import { config } from "../config.js";

/**
 * Read-only display server. No database connection: everything is read from
 * the management API.
 */
const app = createDashboardApp();

const server = app.listen(config.port, () => {
  console.log(
    `[dashboard] listening on http://localhost:${config.port} (${config.nodeEnv})`
  );
  console.log(`[dashboard] metrics source: ${config.apiBaseUrl}`);
});

const shutdown = (signal: string): void => {
  console.log(`[dashboard] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
