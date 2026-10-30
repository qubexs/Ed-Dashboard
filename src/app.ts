import express from "express";

import { createBaseApp } from "./apps/base.js";
import { errorHandler, notFoundHandler } from "./apps/errors.js";
import apiRouter from "./routes/api.js";
import providerRouter from "./routes/provider.js";
import integrationRouter from "./routes/integration.js";
import dashboardRouter from "./routes/dashboard.js";
import authRouter from "./routes/auth.js";
import adminRouter from "./routes/admin.js";
import {
  attachCsrf,
  consumeFlash,
  requireAuth,
  verifyCsrf,
} from "./middleware/auth.js";

/**
 * Legacy single-process app: display + admin + integration API on one port.
 * Kept for `npm run dev` / `npm start` and the Docker image.
 * Use `npm run dev:all` for the three-server layout.
 */
const app = createBaseApp({ sessions: true });

app.use("/api/integration", integrationRouter);
app.use("/api/v1", providerRouter);
app.use("/api", apiRouter);
app.use("/", dashboardRouter);

app.use("/admin", attachCsrf, verifyCsrf, consumeFlash);
app.use("/admin", authRouter);
app.use("/admin", requireAuth, adminRouter);

app.use(notFoundHandler);
app.use(
  errorHandler as unknown as express.ErrorRequestHandler
);

export default app;
