import express from "express";

import { createBaseApp } from "./base.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { config } from "../config.js";
import apiRouter from "../routes/api.js";
import providerRouter from "../routes/provider.js";
import integrationRouter from "../routes/integration.js";
import authRouter from "../routes/auth.js";
import adminRouter from "../routes/admin.js";
import {
  attachCsrf,
  consumeFlash,
  requireAuth,
  verifyCsrf,
} from "../middleware/auth.js";

/**
 * Management API server (default port 4000).
 *
 * Owns the database and exposes:
 *   /admin/*            management panel (patients, wards, zones, users, PMS, keys)
 *   /api/dashboard      live metrics consumed by the dashboard server
 *   /api/display-config public display settings
 *   /api/qr             QR image for the display
 *   /api/health         database health
 *   /api/integration/*  push API for a patient management system
 */
export function createApiApp(): express.Express {
  const app = createBaseApp({ sessions: true });

  // The display lives on its own server; point every link at it.
  app.use((_req, res, next) => {
    res.locals.displayUrl = config.dashboardBaseUrl;
    res.locals.apiOrigin = config.apiBaseUrl;
    next();
  });

  // The API server has no display of its own; send browsers to the panel.
  app.get("/", (_req, res) => {
    res.redirect("/admin");
  });

  app.use("/api/integration", integrationRouter);
  app.use("/api/v1", providerRouter);
  app.use("/api", apiRouter);

  app.use("/admin", attachCsrf, verifyCsrf, consumeFlash);
  app.use("/admin", authRouter);
  app.use("/admin", requireAuth, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler as unknown as express.ErrorRequestHandler);

  return app;
}
