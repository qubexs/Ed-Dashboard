import type express from "express";

/** JSON for /api/* paths, EJS error page everywhere else. */
export function notFoundHandler(
  req: express.Request,
  res: express.Response
): void {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }
  res.status(404).render("error", {
    page: "error",
    status: 404,
    message: "The page you are looking for does not exist.",
  });
}

export function errorHandler(
  err: Error & { status?: number },
  req: express.Request,
  res: express.Response,
  _next: express.NextFunction
): void {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }
  if (req.path.startsWith("/api/")) {
    res.status(status).json({
      ok: false,
      error: status >= 500 ? "Internal server error" : err.message,
    });
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
