import express from "express";
import { getDashboardData } from "../services/summary.js";
import { getSettings } from "../services/settings.js";
import { asyncHandler, safeZoneColor } from "../utils/helpers.js";

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [data, settings] = await Promise.all([
      getDashboardData(),
      getSettings(),
    ]);
    const zones = data.zones.map((zone) => ({
      ...zone,
      color: safeZoneColor(zone.color),
    }));
    res.render("dashboard", {
      data: { ...data, zones },
      settings,
      page: "dashboard",
    });
  })
);

export default router;
