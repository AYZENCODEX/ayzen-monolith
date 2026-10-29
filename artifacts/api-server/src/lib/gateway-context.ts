import type { Request, Response, NextFunction } from "express";
import { getCurrentTraceContext, traceContextFromHeaders } from "./trace-context";

export interface GatewayRequestContext {
  requestId: string;
  traceId: string;
  correlationId?: string;
  causationId?: string;
  workspaceId?: number;
  botKey?: string;
}

declare global {
  namespace Express {
    interface Request {
      gatewayContext?: GatewayRequestContext;
      workspace?: {
        id: number;
        slug: string;
        name: string;
        kind: "personal" | "organization";
        role: string;
      };
    }
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function safeToken(value: string | undefined): string | undefined {
  if (!value || !/^[a-z0-9-]{1,64}$/.test(value)) return undefined;
  return value;
}

export function gatewayContextFromRequest(req: Request): GatewayRequestContext {
  const trace = getCurrentTraceContext() ?? traceContextFromHeaders(req.headers);
  return {
    requestId: trace.traceId,
    traceId: trace.traceId,
    correlationId: trace.correlationId,
    causationId: trace.causationId,
    workspaceId: positiveInteger(req.header("x-workspace-id")),
    botKey: safeToken(req.header("x-telegram-bot-key")),
  };
}

/** API Gateway context only parses transport metadata; it never authorizes it. */
export function gatewayContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const context = gatewayContextFromRequest(req);
  req.gatewayContext = context;
  res.setHeader("x-request-id", context.requestId);
  next();
}