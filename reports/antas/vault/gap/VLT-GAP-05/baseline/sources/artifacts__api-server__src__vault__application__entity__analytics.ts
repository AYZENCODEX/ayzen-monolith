import { db } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { selectVault, selectVaultOne } from "../../infrastructure/repositories/entity-repository";
import { ENTITY_GAS_CHAINS, addressesFor } from "../../domain/entity/calculations";
import { formatVaultEntry as formatRow } from "./representation";
import type { EntityResult } from "./lifecycle";

/**
 * Entity calculations & analytics read models (gas overview, per-entity gas,
 * portfolio analytics, value history). Extracted verbatim from routes/vault.ts
 * (VLT-GAP-01-D).
 */

// ─── GET /vault/gas-overview — gas health across every one of the user's ────
// vault entities in one call. Powers the "Gas" tab on the entities list page:
// total native-coin (gas) value on hand, the worst risk level seen anywhere
// (drives a banner/badge), and a per-entity risk summary so at-a-glance you
// can see which entities are running low before a farmed account gets stuck
// mid-transaction with no gas to finish it.
export async function getGasOverviewForUser(userId: number): Promise<EntityResult> {
  try {
    const { getGasOverview } = await import("../../../lib/gas-health");
    const entries = await selectVault(userId);

    const entitiesWithAddresses = entries
      .map((e) => ({ entry: e, addresses: addressesFor(e) }))
      .filter((x) => x.addresses.length > 0);

    const perEntity = await Promise.all(entitiesWithAddresses.map(async ({ entry, addresses }) => {
      const overview = await getGasOverview(addresses, [...ENTITY_GAS_CHAINS]);
      return {
        id: entry.id,
        projectName: entry.project_name ?? entry.projectName,
        totalUsd: overview.totalUsd,
        risk: overview.worstRisk,
        // only the chains that actually have a nonzero balance or an error —
        // no point listing 6 chains of "0 balance, healthy-by-default" noise
        chains: overview.snapshots.filter((s) => s.balance > 0 || s.error),
      };
    }));

    const totalUsd = parseFloat(perEntity.reduce((s, e) => s + e.totalUsd, 0).toFixed(2));
    const atRisk = perEntity.filter((e) => e.risk === "critical" || e.risk === "warning")
      .sort((a, b) => (a.risk === "critical" ? -1 : 1) - (b.risk === "critical" ? -1 : 1));

    return { status: 200, body: {
      totalUsd,
      entityCount: perEntity.length,
      atRiskCount: atRisk.length,
      atRisk,
      entities: perEntity,
    } };
  } catch (err: any) {
    return { status: 500, body: { error: "Unable to load gas overview", detail: err?.message } };
  }
}

// ─── GET /vault/:id/gas — gas health for one entity, per chain, with the ────
// same real-time simulation as the overview (live gas price + how many more
// native sends / ERC-20 transfers the current balance covers on each chain).
// This is what renders when an entity is clicked open onto its own Gas tab.
export async function getEntityGas(userId: number, idParam: string | string[]): Promise<EntityResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);

  const entry = await selectVaultOne(id, userId);
  if (!entry) { return { status: 404, body: { error: "Vault entry not found" } }; }

  const addresses = addressesFor(entry);
  if (addresses.length === 0) {
    return { status: 200, body: { totalUsd: 0, risk: "unknown", chains: [], message: "This entity has no wallet addresses to check" } };
    
  }

  try {
    const { getGasOverview } = await import("../../../lib/gas-health");
    const overview = await getGasOverview(addresses, [...ENTITY_GAS_CHAINS]);
    return { status: 200, body: {
      totalUsd: overview.totalUsd,
      risk: overview.worstRisk,
      chains: overview.snapshots,
    } };
  } catch (err: any) {
    return { status: 500, body: { error: "Unable to load gas health for this entity", detail: err?.message } };
  }
}

// ─── GET /vault/analytics — portfolio overview, per-platform breakdown, ─────
// value trend, and best/worst performers by ROI.
export async function getEntityAnalytics(userId: number): Promise<EntityResult> {
  try {
    const entries = (await selectVault(userId)).map(e => formatRow(e));

    const totalValue = entries.reduce((s, e: any) => s + (Number(e.currentValue) || 0), 0);
    const totalBuyValue = entries.reduce((s, e: any) => s + (Number(e.currentBuyValue) || 0), 0);
    const avgScore = entries.length ? entries.reduce((s, e: any) => s + (Number(e.score) || 0), 0) / entries.length : 0;

    const byProject: Record<string, { count: number; totalValue: number; totalBuyValue: number; avgScore: number }> = {};
    for (const e of entries as any[]) {
      const key = e.projectName || "Untitled";
      if (!byProject[key]) byProject[key] = { count: 0, totalValue: 0, totalBuyValue: 0, avgScore: 0 };
      byProject[key].count++;
      byProject[key].totalValue += Number(e.currentValue) || 0;
      byProject[key].totalBuyValue += Number(e.currentBuyValue) || 0;
      byProject[key].avgScore += Number(e.score) || 0;
    }
    for (const key of Object.keys(byProject)) {
      byProject[key].avgScore = byProject[key].count ? byProject[key].avgScore / byProject[key].count : 0;
    }

    const platformWorth = (field: "twitterWorth" | "discordWorth" | "telegramWorth", buyField: "twitterBuyValue" | "discordBuyValue" | "telegramBuyValue") => {
      let worth = 0, buy = 0, count = 0;
      for (const e of entries as any[]) {
        const w = Number(e[field]);
        const b = Number(e[buyField]);
        if (Number.isFinite(w) && w !== 0) { worth += w; count++; }
        if (Number.isFinite(b)) buy += b;
      }
      return { totalWorth: worth, totalBuyValue: buy, count };
    };
    const perPlatform = {
      twitter: platformWorth("twitterWorth", "twitterBuyValue"),
      discord: platformWorth("discordWorth", "discordBuyValue"),
      telegram: platformWorth("telegramWorth", "telegramBuyValue"),
    };

    const with2fa = entries.filter((e: any) => e.twitter2fa || e.discord2fa || e.telegram2fa || e.email2fa).length;
    const twofaCoveragePct = entries.length ? Math.round((with2fa / entries.length) * 100) : 0;

    const withRoi = (entries as any[])
      .filter(e => Number(e.currentBuyValue) > 0)
      .map(e => ({
        id: e.id,
        entitySerial: e.entitySerial,
        projectName: e.projectName,
        currentValue: Number(e.currentValue) || 0,
        currentBuyValue: Number(e.currentBuyValue) || 0,
        roiPct: ((Number(e.currentValue) - Number(e.currentBuyValue)) / Number(e.currentBuyValue)) * 100,
      }))
      .sort((a, b) => b.roiPct - a.roiPct);

    return { status: 200, body: {
      overview: {
        totalEntries: entries.length,
        totalVaultWorth: totalValue,
        totalBuyValue,
        netPnl: totalValue - totalBuyValue,
        avgScore: Math.round(avgScore * 10) / 10,
        twofaCoveragePct,
      },
      byProject,
      perPlatform,
      bestPerforming: withRoi.slice(0, 5),
      worstPerforming: withRoi.slice(-5).reverse(),
    } };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch analytics", detail: err?.message } };
  }
}

// ─── GET /vault/analytics/value-history — value_history rows for charting ───
export async function getEntityValueHistory(userId: number): Promise<EntityResult> {
  try {
    const { valueHistoryTable } = await import("@workspace/db");
    const rows = await db.select().from(valueHistoryTable)
      .where(and(eq(valueHistoryTable.userId, userId), eq(valueHistoryTable.sourceType, "vault")))
      .orderBy(valueHistoryTable.createdAt);
    return { status: 200, body: rows.map((r: any) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch value history", detail: err?.message } };
  }
}
