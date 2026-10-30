import { config } from "../src/config.js";
import pool from "../src/db.js";
import { migrate } from "../src/schema.js";
import { getSettings, updateSettings } from "../src/services/settings.js";

/**
 * Point the API server's scheduled pull at the local PMS simulator.
 * Run after `npm run dev:all` (or whenever PMS_PORT / PMS_BASE_URL changes).
 */
try {
  await migrate();

  await updateSettings({
    pms_enabled: "true",
    pms_base_url: config.pmsBaseUrl,
    pms_api_key: config.pmsServerToken,
    pms_patients_path: "/patients",
    pms_wards_path: "/wards",
    pms_interval_seconds: "15",
    pms_patient_map: "",
    pms_ward_map: "",
    pms_status_map: "",
    pms_zone_map: "",
    pms_headers: "",
    pms_last_sync_at: "",
    pms_last_status: "never",
    pms_last_message: "",
  });

  const settings = await getSettings();
  console.log("[pms:connect] scheduled pull configured");
  console.log(`               base URL : ${settings.pms_base_url}`);
  console.log(`               patients : ${settings.pms_patients_path}`);
  console.log(`               wards    : ${settings.pms_wards_path}`);
  console.log(`               interval : ${settings.pms_interval_seconds}s`);
  console.log(
    `               auth     : ${config.pmsApiKey ? "PMS_API_KEY from env" : "token stored in settings"}`
  );
} catch (err) {
  console.error(
    "[pms:connect] failed:",
    err instanceof Error ? err.message : err
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
