/**
 * routes/vault-migration.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 13 — Import/Export Migration Tool.
 *
 * Export: GET /vault/export?format=csv|json — a portable (NOT encrypted)
 * dump of the caller's own active Vault entries, for moving data to another
 * tool or for personal backup. This is deliberately lighter than Feature 15
 * (routes/vault-snapshot.ts), which produces a single password-encrypted
 * blob of the *entire* vault for disaster recovery.
 *
 * Import: POST /vault/import — accepts AYZEN's own CSV/JSON export format,
 * or a raw CSV export from 1Password, Bitwarden, or LastPass. Row-level
 * failures never abort the whole import.
 *
 * VLT-GAP-13: every handler is a thin delegating adapter. Auth/limiter/body parser, the
 * 401 guard and response mapping stay here; the export column list, per-format mappers,
 * encryption, row loop and activity events live in vault/application/migration/use-cases
 * (bodies unchanged from the pre-extraction route).
 */
import { Router } from "express";
import express from "express";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { exportVault, importVault } from "../vault/application/migration/use-cases";
import { respondWithVaultResult } from "../vault/application/use-case-result";

const router = Router();

// Import bodies (a full CSV/JSON export) can be larger than the app-wide
// JSON_BODY_LIMIT — scoped bump, same reasoning as vault-attachments.ts.
const importBodyParser = express.json({ limit: "15mb" });

router.get("/vault/export", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  respondWithVaultResult(res, await exportVault(userId, req.query.format));
});

router.post("/vault/import", requireAuth, importBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  respondWithVaultResult(res, await importVault(userId, req.body));
});

export default router;
