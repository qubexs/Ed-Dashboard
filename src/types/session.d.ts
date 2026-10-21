import "express-session";

export type FlashType = "success" | "error" | "info";

export interface SessionUser {
  id: number;
  username: string;
  role: string;
}

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    csrfToken?: string;
    flash?: { type: FlashType; message: string } | null;
  }
}
