import type { SignOptions } from "jsonwebtoken";
import { getUserFromToken, type AuthError } from "./auth-utils";
import { signAuthToken, type AuthTokenPayload } from "./jwt";

/**
 * Phase 8 — identity service seam.
 *
 * Authentication and token issuance are exposed behind this contract so
 * routes and future extracted services do not need to know JWT/database
 * implementation details.
 */
export type IdentityPrincipal = NonNullable<Awaited<ReturnType<typeof getUserFromToken>>>;
export type IdentityServiceError = AuthError;

export async function authenticateAccessToken(token: string): Promise<IdentityPrincipal | null> {
  return getUserFromToken(token);
}

export function issueSessionToken(
  userId: number,
  role: string,
  options?: SignOptions & { sid?: string; scopes?: string[]; roles?: string[]; stepUpAt?: string },
): string {
  return signAuthToken(userId, role, options);
}

export type { AuthTokenPayload };