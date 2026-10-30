import express from "express";
import path from "node:path";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import morgan from "morgan";

import pool from "../db.js";
import { config } from "../config.js";

export interface BaseAppOptions {
  /** Enable cookie sessions backed by Postgres (admin/API servers only). */
  sessions?: boolean;
  /** Extra browser origins allowed to call (CSP connect-src). Defaults to self. */
  connectSrc?: string[];
  /** Absolute path to the EJS views directory. */
  viewsDir?: string;
}

/**
 * Shared Express setup: security headers, logging, body parsers, static files,
 * view engine and (optionally) Postgres-backed sessions.
 */
export function createBaseApp(options: BaseAppOptions = {}): express.Express {
  const {
    sessions = true,
    connectSrc = [],
    viewsDir = path.join(process.cwd(), "src", "views"),
  } = options;

  const app = express();

  if (config.trustProxy) app.set("trust proxy", 1);

  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", viewsDir);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'", ...connectSrc],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  if (!config.isProduction) {
    app.use(morgan("dev"));
  }

  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(express.json({ limit: "64kb" }));

  app.use(
    express.static(path.join(process.cwd(), "public"), {
      maxAge: config.isProduction ? "1h" : 0,
      etag: true,
    })
  );

  app.locals.formatDateTime = (
    value: unknown,
    timeZone = "Asia/Kuala_Lumpur"
  ): string => {
    if (!value) return "—";
    const date = new Date(value as string);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  };

  app.locals.statusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      waiting: "Waiting",
      in_treatment: "In treatment",
      waiting_ward: "Waiting ward",
      discharged: "Discharged",
      cancelled: "Cancelled",
      admitted: "Admitted",
    };
    return labels[status] || status;
  };

  app.locals.formatNumber = (value: unknown): string =>
    new Intl.NumberFormat("en-US").format(Number(value) || 0);

  /** Link target for "Open live display"; the API app points this at its dashboard. */
  app.locals.displayUrl = "/";
  app.locals.adminUrl = "/admin";
  /** Public origin of the API server, shown in API docs. */
  app.locals.apiOrigin = "";

  if (sessions) {
    const PgSession = connectPgSimple(session);

    app.use(
      session({
        store: new PgSession({
          pool: pool as never,
          tableName: "session",
          createTableIfMissing: true,
        }),
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        name: "eddash.sid",
        cookie: {
          httpOnly: true,
          sameSite: "lax",
          secure: config.isProduction && config.trustProxy ? "auto" : false,
          maxAge: 8 * 60 * 60 * 1000,
        },
      })
    );
  }

  return app;
}
