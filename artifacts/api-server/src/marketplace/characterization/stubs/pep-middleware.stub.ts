// MKT-01b stub of lib/policy/pep/middleware.ts: ownership gates let every request through. Authorization is not what this
// suite characterizes (money and state transitions are); the PEP has its own tests.
import type { NextFunction, Request, Response } from "express";
export function requireOwnership(..._args: unknown[]) {
  return (_req: Request, _res: Response, next: NextFunction): void => next();
}
