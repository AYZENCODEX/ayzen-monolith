/**
 * VLT-GAP-19: classifies a database failure as "this column does not exist" (Postgres undefined_column, SQLSTATE 42703).
 *
 * The entity create/update use-cases keep a legacy fallback that retries without the newer columns for installs whose schema
 * migration has not run yet. That fallback is only valid for exactly that failure. Taking it for any other error (a dropped
 * connection, a timeout, a deadlock) silently stored or applied a reduced entity — missing the seed phrase and credentials —
 * and returned success, or inserted a second row when the first insert had actually committed.
 */
export function isMissingColumnError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null | undefined;
  if (!e) return false;
  if (e.code === "42703" || e.cause?.code === "42703") return true;
  const text = `${String(e.message ?? "")} ${String(e.cause?.message ?? "")}`;
  return /column ".*" (of relation ".*" )?does not exist/i.test(text);
}
