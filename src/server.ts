import app from "./app.js";
import { config } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { startPmsScheduler, stopPmsScheduler } from "./services/pms.js";
import pool from "./db.js";

async function main(): Promise<void> {
  await bootstrap();

  const server = app.listen(config.port, () => {
    console.log(
      `[eddash] listening on http://localhost:${config.port} (${config.nodeEnv})`
    );
    startPmsScheduler();
  });

  const shutdown = (signal: string): void => {
    console.log(`[eddash] ${signal} received, shutting down`);
    stopPmsScheduler();
    server.close(() => {
      pool
        .end()
        .catch((err) => console.error("[eddash] failed to close pool", err))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[eddash] failed to start:", err);
  process.exit(1);
});
