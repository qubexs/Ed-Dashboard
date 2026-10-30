import { config } from "../config.js";

export class ApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `timed out after ${config.apiTimeoutMs}ms`;
    }
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code || err.message;
  }
  return "unknown error";
}

/** Fetch a URL from the management API with a hard timeout. */
export async function apiFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = `${config.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(config.apiTimeoutMs),
      headers: { Accept: "application/json", ...(init.headers || {}) },
    });
  } catch (err) {
    throw new ApiUnavailableError(`API request to ${path} failed: ${reason(err)}`);
  }
}

export async function apiGetJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  const text = await response.text();

  if (!response.ok) {
    throw new ApiUnavailableError(
      `API ${path} returned HTTP ${response.status}`
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiUnavailableError(`API ${path} did not return valid JSON`);
  }
}
