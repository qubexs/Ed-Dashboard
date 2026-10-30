import express from "express";

import { createBaseApp } from "./base.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { config } from "../config.js";
import type { DashboardData } from "../services/summary.js";
import { apiFetch, apiGetJson } from "../services/apiClient.js";
import { safeZoneColor } from "../utils/helpers.js";

export type DisplaySettings = Record<string, string>;

export interface DisplaySnapshot {
  data: DashboardData;
  settings: DisplaySettings;
  cachedAt: number;
}

/** Last good payload, so a restart of the API server does not blank a kiosk. */
let snapshot: DisplaySnapshot | null = null;
let qrCache: { buffer: Buffer; at: number } | null = null;

const QR_CACHE_MS = 60_000;

function normaliseData(data: DashboardData): DashboardData {
  return {
    ...data,
    zones: (data.zones || []).map((zone) => ({
      ...zone,
      color: safeZoneColor(zone.color),
    })),
  };
}

async function loadDisplay(): Promise<DisplaySnapshot> {
  const [data, config] = await Promise.all([
    apiGetJson<DashboardData>("/api/dashboard"),
    apiGetJson<{ settings: DisplaySettings }>("/api/display-config"),
  ]);

  snapshot = {
    data: normaliseData(data),
    settings: config.settings || {},
    cachedAt: Date.now(),
  };
  return snapshot;
}

/**
 * Read-only display server (default port 3000).
 *
 * Holds no database connection. Everything comes from the management API:
 *   /                server-rendered display (EJS)
 *   /api/dashboard   proxy of the API metrics, polled by the kiosk browser
 *   /api/qr          proxy of the API QR image
 *   /health          API reachability
 */
export function createDashboardApp(): express.Express {
  const app = createBaseApp({ sessions: false });

  // The display has no admin panel; links go to the management server.
  app.use((_req, res, next) => {
    res.locals.adminUrl = `${config.apiBaseUrl}/admin`;
    next();
  });

  app.get(
    "/",
    async (_req, res) => {
      try {
        const current = await loadDisplay();
        res.set("Cache-Control", "no-store");
        res.render("dashboard", {
          data: current.data,
          settings: current.settings,
          page: "dashboard",
        });
      } catch (err) {
        console.error(`[dashboard] ${(err as Error).message}`);
        if (snapshot) {
          res.set("Cache-Control", "no-store");
          res.status(503).render("dashboard", {
            data: snapshot.data,
            settings: snapshot.settings,
            page: "dashboard",
          });
          return;
        }
        res.status(503).render("dashboard-offline", { page: "offline" });
      }
    }
  );

  app.get("/api/dashboard", async (_req, res) => {
    try {
      const response = await apiFetch("/api/dashboard");
      const text = await response.text();

      res
        .status(response.status)
        .set("Content-Type", "application/json; charset=utf-8")
        .set("Cache-Control", "no-store")
        .send(text);

      if (response.ok && snapshot) {
        try {
          snapshot = {
            ...snapshot,
            data: normaliseData(JSON.parse(text) as DashboardData),
            cachedAt: Date.now(),
          };
        } catch {
          /* keep the previous snapshot */
        }
      }
    } catch (err) {
      console.error(`[dashboard] metrics proxy: ${(err as Error).message}`);
      res
        .status(503)
        .set("Cache-Control", "no-store")
        .json({ ok: false, error: "API unavailable" });
    }
  });

  app.get("/api/qr", async (_req, res) => {
    if (qrCache && Date.now() - qrCache.at < QR_CACHE_MS) {
      res
        .set("Content-Type", "image/png")
        .set("Cache-Control", "public, max-age=60")
        .send(qrCache.buffer);
      return;
    }

    try {
      const response = await apiFetch("/api/qr", {
        headers: { Accept: "image/png" },
      });
      if (!response.ok) throw new Error(`API /api/qr returned HTTP ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      qrCache = { buffer, at: Date.now() };

      res
        .set("Content-Type", "image/png")
        .set("Cache-Control", "public, max-age=60")
        .send(buffer);
    } catch (err) {
      console.error(`[dashboard] qr proxy: ${(err as Error).message}`);
      res.status(503).type("text/plain").send("QR code unavailable");
    }
  });

  app.get("/health", async (_req, res) => {
    try {
      const health = await apiGetJson<unknown>("/api/health");
      res.json({
        status: "ok",
        server: "dashboard",
        cachedPayload: snapshot ? new Date(snapshot.cachedAt).toISOString() : null,
        api: health,
      });
    } catch (err) {
      res.status(503).json({
        status: "degraded",
        server: "dashboard",
        error: (err as Error).message,
      });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler as unknown as express.ErrorRequestHandler);

  return app;
}
