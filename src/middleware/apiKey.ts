import type { NextFunction, Request, Response } from "express";
import pool from "../db.js";
import { hashApiKey } from "../services/apiKeys.js";

export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
}

function readKey(req: Request): string {
  const header = req.get("x-api-key");
  if (header) return header.trim();

  const authorization = req.get("authorization") || "";
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  return "";
}

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const key = readKey(req);
  if (!key) {
    res.status(401).json({
      ok: false,
      error: "Missing API key. Send it in the X-API-Key header.",
    });
    return;
  }

  try {
    const { rows } = await pool.query<ApiKeyInfo>(
      "SELECT id, name, prefix FROM api_keys WHERE key_hash = $1",
      [hashApiKey(key)]
    );
    const apiKey = rows[0];
    if (!apiKey) {
      res.status(401).json({ ok: false, error: "Invalid API key." });
      return;
    }

    res.locals.apiKey = apiKey;
    await pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [
      apiKey.id,
    ]);
    next();
  } catch (err) {
    next(err);
  }
}
