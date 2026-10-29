import type { Request, Response } from "express";

/**
 * VLT-GAP-14-B: the single Vault-owned place where Express transport types are
 * named. Application/shared code that only passes a request/response through to
 * security or infrastructure collaborators imports these aliases instead of
 * `express`, so the application layer stays free of HTTP framework imports.
 * The aliases ARE the Express types (no structural narrowing), so every
 * collaborator that takes an Express Request/Response accepts them unchanged.
 */
export type VaultRequest = Request;
export type VaultResponse = Response;
