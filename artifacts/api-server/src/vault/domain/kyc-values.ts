/**
 * Pure value-binding helpers shared by the KYC persistence layer. Extracted
 * verbatim from routes/kyc.ts (`val`, `numVal`) and routes/kyc-data-entities.ts
 * (`safe`, `safeDate`) in VLT-GAP-03-B. `d` reproduces the destructuring
 * defaults the old handlers relied on (`x = default` only fires on undefined).
 */

// Bind a value as a parameter, normalizing "" / undefined to SQL NULL.
export const val = (v: unknown) => (v === null || v === undefined || v === "" ? null : v);
export const numVal = (v: unknown) => (isNaN(Number(v)) ? 0 : Number(v));

// Safely escape a string for SQL — the kyc-data-entities table is written through sql.raw().
export const safe = (v: unknown) => v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
export const safeDate = (v: unknown) => v ? `'${String(v).replace(/'/g, "''")}'` : "NULL";

// Mirrors the destructuring defaults the old handlers applied (`x = default` only fires on undefined).
export const d = (v: unknown, dflt: unknown): any => (v === undefined ? dflt : v);
