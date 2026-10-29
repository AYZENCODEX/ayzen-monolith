import type { Request, Response } from "express";

/**
 * VLT-GAP-16-B: the ownership-denial responders shared by the game, KYC and local-account ownership
 * modules. Each module used to declare its own byte-identical copy under a module-specific name. The
 * response bodies are unchanged: 404 {error:"Not found"}, 404 {error:"Not found or forbidden"} and the
 * silent-success no-op (200 {success:true}) used by deletes so a non-owner learns nothing.
 */
export const denyNotFound = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); };
export const denyNotFoundOrForbidden = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found or forbidden" }); };
export const denySilentSuccess = (_req: Request, res: Response) => { res.json({ success: true }); };
