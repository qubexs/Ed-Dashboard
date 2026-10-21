import type { NextFunction, Request, Response, RequestHandler } from "express";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function isHexColor(value: unknown): boolean {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""));
}

export function safeZoneColor(value: unknown): string {
  return isHexColor(value) ? String(value) : "#5FE3D6";
}
