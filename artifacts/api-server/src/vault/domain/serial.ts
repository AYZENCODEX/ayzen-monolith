import crypto from "crypto";

/** Stable display identifier generator shared by create/import/restore paths. */
export function generateSerial(userId: number): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `AYZN${userId}-${ts}${rand}`;
}
