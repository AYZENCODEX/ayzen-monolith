import { type VaultResponse } from "../security/request-context";

/**
 * VLT-GAP-16-B: the single use-case result shape and its response mapper. The attachment, migration and
 * snapshot use cases each carried an identical copy of `respondWith…Result`; they now share this one.
 * `send` is the raw payload (CSV export, attachment `?raw=1`, snapshot download); when present it is sent
 * instead of the JSON `body`.
 */
export interface VaultUseCaseResult {
  status: number;
  body?: unknown;
  /** Response headers (raw download / export). */
  headers?: Record<string, string>;
  /** Raw payload; when present the route sends it instead of JSON. */
  send?: string | Buffer;
}

/** Standard result shape used by database-backed vault application use-cases. */
export interface VaultOperationResult {
  status: number;
  body: unknown;
  streamed?: boolean;
}

/** Preserve the shared API's existing database-error response contract. */
export function vaultDbError(err: any): VaultOperationResult {
  return { status: 500, body: { error: "DB error", detail: err?.message } };
}

// Maps a use-case result onto the response: optional headers, then either a raw payload or JSON.
export function respondWithVaultResult(res: VaultResponse, out: VaultUseCaseResult): void {
  if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  if (out.send !== undefined) res.status(out.status).send(out.send);
  else res.status(out.status).json(out.body);
}
