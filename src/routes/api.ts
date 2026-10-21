import express from "express";
import qrcode from "qrcode";
import { getDashboardData } from "../services/summary.js";
import { getSettings } from "../services/settings.js";
import { asyncHandler } from "../utils/helpers.js";
import { health } from "../db.js";

const router = express.Router();

router.get(
  "/dashboard",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await getDashboardData());
  })
);

router.get(
  "/qr",
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    const target = settings.qr_url || "https://hospitalampang.moh.gov.my";
    const buffer = await qrcode.toBuffer(target, {
      type: "png",
      width: 512,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0B1220FF", light: "#FFFFFFFF" },
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=60");
    res.send(buffer);
  })
);

router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    try {
      const result = await health();
      res.json({ status: "ok", database: result });
    } catch (err) {
      res.status(503).json({
        status: "error",
        message: err instanceof Error ? err.message : "Database unavailable",
      });
    }
  })
);

export default router;
