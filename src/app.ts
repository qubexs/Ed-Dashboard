import express from "express";
import path from "node:path";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import morgan from "morgan";

import pool from "./db.js";
import { config } from "./config.js";
import apiRouter from "./routes/api.js";
import dashboardRouter from "./routes/dashboard.js";
import authRouter from "./routes/auth.js";
import adminRouter from "./routes/admin.js";
import {
  attachCsrf,
  consumeFlash,
  requireAuth,
  verifyCsrf,
} from "./middleware/auth.js";

const app = express();

if (config.trustProxy) app.set("trust proxy", 1);

app.disable("x-powered-by");
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src", "views"));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
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

app.locals.formatDateTime = (value: unknown, timeZone = "Asia/Kuala_Lumpur"): string => {
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

app.use("/api", apiRouter);
app.use("/", dashboardRouter);

app.use("/admin", attachCsrf, verifyCsrf, consumeFlash);
app.use("/admin", authRouter);
app.use("/admin", requireAuth, adminRouter);

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(404).render("error", {
    page: "error",
    status: 404,
    message: "The page you are looking for does not exist.",
  });
});

app.use(
  (
    err: Error & { status?: number },
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const status = err.status || 500;
    if (status >= 500) {
      console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    }
    if (req.path.startsWith("/api/")) {
      res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
      return;
    }
    res.status(status).render("error", {
      page: "error",
      status,
      message:
        status >= 500
          ? "Something went wrong on our side. Please try again."
          : err.message,
    });
  }
);

export default app;
