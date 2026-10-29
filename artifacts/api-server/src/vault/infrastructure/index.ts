/**
 * Infrastructure boundary: providers, persistence, recovery, and schedules.
 * These exports make ownership explicit without duplicating legacy adapters.
 * VLT-GAP-14-B: infrastructure no longer re-exports application modules
 * (snapshot restore + health scan are exported from ../application instead).
 */
export * from "../crypto/backup-envelope";
