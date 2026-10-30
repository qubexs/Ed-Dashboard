import { createPmsApp } from "../apps/pms.js";
import { config } from "../config.js";
import pool from "../db.js";
import { migratePms } from "../pms/schema.js";
import { getCounts, seedDemo } from "../pms/store.js";

/**
 * Patient Management System simulator: owns the pms.* schema and feeds the
 * EDDASH API server over HTTP.
 */
async function main(): Promise<void> {
  await migratePms();

  if (config.pmsSeedDemo) {
    const counts = await getCounts();
    if (counts.total === 0) {
      const created = await seedDemo(40);
      console.log(`[pms] seeded ${created} demo patients`);
    }
  }

  const app = createPmsApp();
  const server = app.listen(config.pmsPort, () => {
    console.log(
      `[pms] listening on http://localhost:${config.pmsPort} (${config.nodeEnv})`
    );
    console.log(`[pms] console: http://localhost:${config.pmsPort}/`);
    console.log(`[pms] feed: ${config.pmsBaseUrl}/patients`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[pms] ${signal} received, shutting down`);
    server.close(() => {
      pool
        .end()
        .catch((err) => console.error("[pms] failed to close pool", err))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[pms] failed to start:", err);
  process.exit(1);
});
