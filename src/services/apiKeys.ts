import crypto from "node:crypto";

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  hash: string;
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const key = `edd_${crypto.randomBytes(24).toString("hex")}`;
  return {
    key,
    prefix: key.slice(0, 12),
    hash: hashApiKey(key),
  };
}
