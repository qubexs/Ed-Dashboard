import pool from "../db.js";

export type Settings = Record<string, string>;

export const DEFAULT_SETTINGS: Settings = {
  hospital_name: "Hospital Ampang",
  hospital_subtitle:
    "Jabatan Kecemasan & Trauma / Emergency & Trauma Department — Hulu Langat",
  logo_url: "/img/logo.svg",
  footer_message:
    "Menunggu terlalu lama? Anda boleh mendapatkan rawatan di fasiliti kesihatan berdekatan.",
  footer_message_en:
    "Waiting too long? You may seek treatment at a nearby health facility.",
  qr_url: "https://hospitalampang.moh.gov.my",
  qr_caption: "Imbas untuk maklumat lanjut / Scan for more info",
  timezone: "Asia/Kuala_Lumpur",
  refresh_seconds: "10",
  waiting_buffer_minutes: "0",
  waiting_fallback_minutes: "0",
};

export const EDITABLE_SETTINGS = Object.keys(DEFAULT_SETTINGS);

export async function getSettings(): Promise<Settings> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    "SELECT key, value FROM settings"
  );
  const values: Settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    values[row.key] = row.value;
  }
  return values;
}

export async function updateSettings(values: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(values).filter(([key]) =>
    EDITABLE_SETTINGS.includes(key)
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, String(value ?? "")]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
