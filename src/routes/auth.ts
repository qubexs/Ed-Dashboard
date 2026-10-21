import express from "express";
import bcrypt from "bcryptjs";
import pool from "../db.js";
import { setFlash } from "../middleware/auth.js";
import { asyncHandler } from "../utils/helpers.js";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
}

const router = express.Router();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

function isBlocked(ip: string): number {
  const entry = attempts.get(ip);
  if (!entry) return 0;
  if (Date.now() > entry.resetAt) {
    attempts.delete(ip);
    return 0;
  }
  if (entry.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((entry.resetAt - Date.now()) / 60_000);
}

function recordFailure(ip: string): void {
  const entry = attempts.get(ip) || {
    count: 0,
    resetAt: Date.now() + WINDOW_MS,
  };
  entry.count += 1;
  attempts.set(ip, entry);
}

function safeNext(value: unknown): string {
  if (
    typeof value === "string" &&
    (value === "/admin" || value.startsWith("/admin/")) &&
    !value.startsWith("/admin/login")
  ) {
    return value;
  }
  return "/admin";
}

router.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/admin");
  res.render("admin/login", {
    page: "login",
    next: safeNext(req.query.next),
    error: null,
  });
});

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const next = safeNext(req.body.next);
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const ip = req.ip || req.socket.remoteAddress || "unknown";

    const blockedMinutes = isBlocked(ip);
    if (blockedMinutes > 0) {
      res.status(429).render("admin/login", {
        page: "login",
        next,
        error: `Too many attempts. Try again in ${blockedMinutes} minute(s).`,
      });
      return;
    }

    const { rows } = await pool.query<UserRow>(
      "SELECT id, username, password_hash, role FROM users WHERE username = $1",
      [username]
    );

    const user = rows[0];
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!valid) {
      recordFailure(ip);
      res.status(401).render("admin/login", {
        page: "login",
        next,
        error: "Invalid username or password.",
      });
      return;
    }

    attempts.delete(ip);
    req.session.regenerate((err) => {
      if (err) {
        res.status(500).render("admin/login", {
          page: "login",
          next,
          error: "Could not start a session. Please try again.",
        });
        return;
      }
      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role,
      };
      setFlash(req, "success", `Welcome back, ${user.username}.`);
      res.redirect(next);
    });
  })
);

router.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("eddash.sid");
    res.redirect("/admin/login");
  });
});

export default router;
