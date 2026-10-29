import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, serviceRequestNoncesTable } from "@workspace/db";
import { lt } from "drizzle-orm";
import { DOMAIN_SERVICES, type DomainService } from "./architecture/domains";
import { stableSerialize } from "./trace-context";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SERVICE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

function signingInput(service: string, timestamp: string, requestId: string, bodyHash: string): string {
  return `${service}.${timestamp}.${requestId}.${bodyHash}`;
}

export function hashRequestBody(body: unknown): string {
  return crypto.createHash("sha256").update(stableSerialize(body ?? null)).digest("hex");
}

function configuredSecret(): string | undefined {
  // Keep the existing name for backward compatibility while allowing the
  // roadmap's neutral name for new extracted services.
  return process.env.AYZEN_SERVICE_AUTH_SECRET ?? process.env.SERVICE_TO_SERVICE_SECRET;
}

export function signServiceRequest(input: {
  service: string;
  timestamp: string;
  requestId: string;
  bodyHash: string;
  secret?: string;
}): string {
  const secret = input.secret ?? configuredSecret();
  if (!secret) throw new Error("Service authentication secret is not configured");
  return crypto.createHmac("sha256", secret)
    .update(signingInput(input.service, input.timestamp, input.requestId, input.bodyHash))
    .digest("hex");
}

export function verifyServiceSignature(input: {
  service: string;
  timestamp: string;
  requestId: string;
  bodyHash: string;
  signature: string;
  secret: string;
}): boolean {
  const expected = signServiceRequest(input);
  const actual = Buffer.from(input.signature, "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

export function verifyServiceRequest(req: Request): boolean {
  const service = req.header("x-ayzen-service");
  const timestamp = req.header("x-ayzen-timestamp");
  const requestId = req.header("x-ayzen-request-id");
  const signature = req.header("x-ayzen-signature");
  const secret = configuredSecret();
  if (
    !service
    || !DOMAIN_SERVICES.includes(service as DomainService)
    || !timestamp
    || !requestId
    || !SERVICE_REQUEST_ID.test(requestId)
    || !signature
    || !secret
  ) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) return false;
  return verifyServiceSignature({
    service,
    timestamp,
    requestId,
    bodyHash: hashRequestBody(req.body),
    signature,
    secret,
  });
}

async function claimRequestNonce(service: string, requestId: string, expiresAt: Date): Promise<boolean> {
  await db.delete(serviceRequestNoncesTable).where(lt(serviceRequestNoncesTable.expiresAt, new Date()));
  const claimed = await db.insert(serviceRequestNoncesTable).values({
    service, requestId, expiresAt,
  }).onConflictDoNothing().returning({ id: serviceRequestNoncesTable.id });
  return claimed.length > 0;
}

export async function requireServiceRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!verifyServiceRequest(req)) {
    res.status(401).json({ error: "Invalid service request", code: "INVALID_SERVICE_SIGNATURE" });
    return;
  }
  const service = req.header("x-ayzen-service")!;
  const requestId = req.header("x-ayzen-request-id")!;
  const timestampMs = Number(req.header("x-ayzen-timestamp"));
  try {
    const claimed = await claimRequestNonce(service, requestId, new Date(timestampMs + MAX_CLOCK_SKEW_MS));
    if (!claimed) {
      res.status(409).json({ error: "Service request has already been used", code: "REPLAYED_SERVICE_REQUEST" });
      return;
    }
  } catch {
    // Authentication must not fail open when durable replay protection is
    // unavailable.
    res.status(503).json({ error: "Service authentication unavailable", code: "SERVICE_AUTH_UNAVAILABLE" });
    return;
  }
  req.servicePrincipal = {
    service: service as DomainService,
    requestId,
    authenticatedAt: Date.now(),
  };
  next();
}

declare global {
  namespace Express {
    interface Request {
      servicePrincipal?: {
        service: DomainService;
        requestId: string;
        authenticatedAt: number;
      };
    }
  }
}
