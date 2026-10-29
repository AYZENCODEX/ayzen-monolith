/**
 * Entity health-check use cases. Moved unchanged from routes/vault.ts (VLT-GAP-13-B): the best-effort
 * per-entry runner (also injected into the entity update use-case as a port), the dashboard health
 * report and the run-everything health check. Status codes and error bodies are identical.
 */
import { computeAutoScore, evalHealthRules, severityEmoji, toHealthInput } from "../health";
import { formatVaultEntry as formatRow } from "./representation";
import { selectVault, selectVaultOne } from "../../infrastructure/repositories/entity-repository";
import { selectUsersForRunHealthCheck, updateVaultEntriesForRunHealthCheck } from "../../infrastructure/repositories/vault-health-repository";
import { createNotificationProvider, sendTelegramToUserProvider } from "../../infrastructure/providers/provider-ports";

export interface EntityHealthResult { status: number; body: unknown }

// ─── Health Monitor runner ────────────────────────────────────────────────────
// Best-effort, fire-and-forget (same pattern as logVaultActivity/syncOnVaultUpdate)
// — never blocks or fails the calling request.
export async function runHealthCheck(id: number, userId: number, recalcScore: boolean): Promise<void> {
  const raw = await selectVaultOne(id, userId);
  if (!raw) return;
  const formatted = formatRow(raw);
  const input = toHealthInput(formatted);

  const dbUpdates: Record<string, unknown> = {};

  if (recalcScore) {
    const auto = computeAutoScore(input);
    if (auto !== input.score) {
      dbUpdates.score = auto;
      input.score = auto;
    }
  }

  const hits = evalHealthRules(input);
  const prevFlags: string[] = Array.isArray((formatted as any).lastHealthFlags) ? (formatted as any).lastHealthFlags : [];
  const currentIds = hits.map(h => h.id);
  const newHits = hits.filter(h => !prevFlags.includes(h.id));

  if (currentIds.join(",") !== prevFlags.join(",")) {
    dbUpdates.lastHealthFlags = JSON.stringify(currentIds);
  }
  if (newHits.length > 0) {
    dbUpdates.lastHealthAlertAt = new Date();
  }

  if (Object.keys(dbUpdates).length > 0) {
    try {
      await updateVaultEntriesForRunHealthCheck(dbUpdates, id, userId);
    } catch (err) {
      console.error("vault health-check update failed:", err);
    }
  }

  if (newHits.length === 0) return;

  const label = formatted.projectName;
  const worst = newHits.find(h => h.severity === "alert") ?? newHits[0];
  const summary = newHits.map(h => `${severityEmoji(h.severity)} ${h.message}`).join("\n");

  createNotificationProvider(
    userId,
    "vault_health",
    `Vault Health: ${worst.severity === "alert" ? "Alert" : worst.severity === "warn" ? "Warning" : "Flag"} — ${label}`,
    summary,
    { vaultEntryId: id, ruleIds: currentIds },
  ).catch(() => {});

  selectUsersForRunHealthCheck(userId)
    .then(rows => {
      const chatId = rows[0]?.telegramChatId;
      if (!chatId) return;
      return sendTelegramToUserProvider(chatId, `${severityEmoji(worst.severity)} *Vault Health*\n\n${label}\n\n${summary}`);
    })
    .catch(() => {});
}

/** GET /vault/health-report — dashboard panel: counts by health issue. */
export async function getHealthReport(userId: number): Promise<EntityHealthResult> {
  try {
    const entries = await selectVault(userId);
    const formatted = entries.map(e => formatRow(e));

    let lowScore = 0, missing2fa = 0, inactive30d = 0, bannedOrSuspended = 0;
    const flagged: Record<string, unknown>[] = [];

    for (const f of formatted) {
      const input = toHealthInput(f);
      const hits = evalHealthRules(input);
      if (hits.length > 0) {
        flagged.push({
          id: (f as any).id,
          entitySerial: (f as any).entitySerial,
          projectName: (f as any).projectName,
          score: input.score,
          hits,
        });
      }
      if (hits.some(h => h.id === "low_score")) lowScore++;
      if (hits.some(h => h.id === "missing_2fa")) missing2fa++;
      if (hits.some(h => h.id === "inactive_30d")) inactive30d++;
      if (hits.some(h => h.id.startsWith("status_"))) bannedOrSuspended++;
    }

    return {
      status: 200,
      body: {
        totalEntries: formatted.length,
        counts: { lowScore, missing2fa, inactive30d, bannedOrSuspended },
        flaggedEntries: flagged,
      },
    };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to generate health report", detail: err?.message } };
  }
}

/** POST /vault/health-check — run the rules engine across all of the user's entries now. */
export async function runHealthCheckForAll(userId: number): Promise<EntityHealthResult> {
  try {
    const entries = await selectVault(userId);
    await Promise.all(entries.map(e => runHealthCheck(Number((e as any).id), userId, true).catch(() => {})));
    return { status: 200, body: { checked: entries.length } };
  } catch (err: any) {
    return { status: 500, body: { error: "Health check failed", detail: err?.message } };
  }
}
