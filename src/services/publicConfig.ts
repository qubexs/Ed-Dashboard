import { getSettings } from "./settings.js";

/** Settings that are safe to expose to displays and API consumers. */
export const PUBLIC_SETTING_KEYS = [
  "hospital_name",
  "hospital_subtitle",
  "logo_url",
  "footer_message",
  "footer_message_en",
  "qr_caption",
  "timezone",
  "refresh_seconds",
] as const;

export type PublicSettings = Record<(typeof PUBLIC_SETTING_KEYS)[number], string>;

export async function getPublicSettings(): Promise<PublicSettings> {
  const settings = await getSettings();
  const result = {} as PublicSettings;
  for (const key of PUBLIC_SETTING_KEYS) {
    result[key] = settings[key] ?? "";
  }
  return result;
}
