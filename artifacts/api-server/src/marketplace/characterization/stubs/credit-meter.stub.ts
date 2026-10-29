// MKT-01b stub of services/credit-meter.ts (used only by the listing boost route).
import type { NextFunction, Request, Response } from "express";
export function requireCreditBalance(_key: string) {
  return (_req: Request, _res: Response, next: NextFunction): void => next();
}
export async function chargeCredits(_userId: number, _key: string): Promise<{ charged: boolean }> { return { charged: false }; }
