import { createApiApp } from "../apps/api.js";
import { bootstrap } from "../bootstrap.js";
import { config } from "../config.js";
import pool from "../db.js";
import { startPmsScheduler, stopPmsScheduler } from "../services/pms.js";

/**
 * Management API server: database, admin panel and integration endpoints.
 */
async function main(): Promise<void> {
  await bootstrap();

  const app = createApiApp();
  const server = app.listen(config.apiPort, () => {
    console.log(
      `[api] listening on http://localhost:${config.apiPort} (${config.nodeEnv})`
    );
    console.log(`[api] admin panel: http://localhost:${config.apiPort}/admin`);
    startPmsScheduler();
  });

  const shutdown = (signal: string): void => {
    console.log(`[api] ${signal} received, shutting down`);
    stopPmsScheduler();
    server.close(() => {
      pool
        .end()
        .catch((err) => console.error("[api] failed to close pool", err))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[api] failed to start:", err);
  process.exit(1);
});
