import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { FlashType } from "../types/session.js";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.user) {
    next();
    return;
  }
  const nextUrl = encodeURIComponent(req.originalUrl || "/admin");
  res.redirect(`/admin/login?next=${nextUrl}`);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.user?.role === "admin") {
    next();
    return;
  }
  setFlash(req, "error", "Your account does not have permission to perform this action.");
  res.redirect("/admin");
}

export function attachCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    next();
    return;
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const expected = req.session?.csrfToken;
  const provided = req.body?._csrf;
  if (
    typeof expected !== "string" ||
    typeof provided !== "string" ||
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    const err: Error & { status?: number } = new Error(
      "Invalid or expired form token. Please try again."
    );
    err.status = 403;
    next(err);
    return;
  }
  next();
}

export function setFlash(req: Request, type: FlashType, message: string): void {
  if (req.session) req.session.flash = { type, message };
}

export function consumeFlash(req: Request, res: Response, next: NextFunction): void {
  res.locals.flash = req.session?.flash || null;
  if (req.session?.flash) delete req.session.flash;
  res.locals.currentUser = req.session?.user || null;
  res.locals.currentPath = req.path;
  next();
}
