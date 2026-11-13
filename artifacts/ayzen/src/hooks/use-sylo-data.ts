/**
 * hooks/use-sylo-data.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Typed read hooks for the Sylo Console and Account section pages. Every hook
 * throws on failure (customFetch → ApiError) so QueryBoundary can render a
 * real error state instead of an empty one.
 *
 * Local / KYC lists are reduced to non-secret aggregates INSIDE queryFn: the
 * list endpoints return full rows (local accounts include decrypted
 * credentials), and reducing here keeps those out of the TanStack cache and
 * out of component state. When a server-side summary endpoint exists, only the
 * body of these two queryFns changes.
 */
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

export const syloKeys = {
  analytics: ["sylo", "entity-analytics"] as const,
  health: ["sylo", "entity-health"] as const,
  activity: (limit: number) => ["sylo", "activity", limit] as const,
  localSummary: ["sylo", "local-summary"] as const,
  kycSummary: ["sylo", "kyc-summary"] as const,
};

/* ─── Entity ─────────────────────────────────────────────────────────────── */

export interface Performer {
  id: number;
  entitySerial: string | null;
  projectName: string;
  currentValue: number;
  currentBuyValue: number;
  roiPct: number;
}

export interface PlatformWorth { totalWorth: number; totalBuyValue: number; count: number }

export interface VaultAnalytics {
  overview: {
    totalEntries: number;
    totalVaultWorth: number;
    totalBuyValue: number;
    netPnl: number;
    avgScore: number;
    twofaCoveragePct: number;
  };
  byProject: Record<string, { count: number; totalValue: number; totalBuyValue: number; avgScore: number }>;
  perPlatform: { twitter: PlatformWorth; discord: PlatformWorth; telegram: PlatformWorth };
  bestPerforming: Performer[];
  worstPerforming: Performer[];
}

export type HealthSeverity = "flag" | "warn" | "alert";

export interface VaultHealthReport {
  totalEntries: number;
  counts: { lowScore: number; missing2fa: number; inactive30d: number; bannedOrSuspended: number };
  flaggedEntries: {
    id: number;
    entitySerial: string | null;
    projectName: string;
    score: number;
    hits: { id: string; severity: HealthSeverity; message: string }[];
  }[];
}

export interface VaultActivityRow {
  id: number;
  vaultEntryId: number;
  action: string;
  detail: string | null;
  createdAt: string;
  entitySerial: string | null;
  entityId: number | null;
}

export interface VaultActivityPage { entries: VaultActivityRow[]; total: number; page: number; limit: number }

export const useVaultAnalytics = () =>
  useQuery({ queryKey: syloKeys.analytics, queryFn: () => customFetch<VaultAnalytics>("/api/vault/analytics") });

export const useVaultHealth = () =>
  useQuery({ queryKey: syloKeys.health, queryFn: () => customFetch<VaultHealthReport>("/api/vault/health-report") });

export const useVaultActivity = (limit = 8) =>
  useQuery({
    queryKey: syloKeys.activity(limit),
    queryFn: () => customFetch<VaultActivityPage>(`/api/vault/activity?limit=${limit}`),
  });

/* ─── Local accounts / KYC (aggregated, secret-free) ─────────────────────── */

export interface CategoryBucket { category: string; count: number; worth: number; buy: number }

export interface AccountSummary {
  total: number;
  totalWorth: number;
  totalBuy: number;
  netPnl: number;
  banned: number;
  byCategory: CategoryBucket[];
}

interface RawAccountRow {
  category?: string | null;
  account_worth?: number | string | null;
  buy_price?: number | string | null;
  status?: string | null;
  paid?: boolean | null;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};

function unwrapRows(payload: unknown, key: string): RawAccountRow[] {
  if (Array.isArray(payload)) return payload as RawAccountRow[];
  if (payload && typeof payload === "object") {
    const inner = (payload as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as RawAccountRow[];
  }
  return [];
}

function summarise(rows: RawAccountRow[]): AccountSummary {
  const buckets = new Map<string, CategoryBucket>();
  let totalWorth = 0, totalBuy = 0, banned = 0;
  for (const r of rows) {
    const worth = num(r.account_worth);
    totalWorth += worth;
    totalBuy += num(r.buy_price);
    if (r.status === "banned") banned++;
    const category = r.category?.trim() || "Other";
    const b = buckets.get(category) ?? { category, count: 0, worth: 0, buy: 0 };
    b.count++;
    b.worth += worth;
    b.buy += num(r.buy_price);
    buckets.set(category, b);
  }
  return {
    total: rows.length,
    totalWorth,
    totalBuy,
    netPnl: totalWorth - totalBuy,
    banned,
    byCategory: [...buckets.values()].sort((a, b) => b.count - a.count),
  };
}

export const useLocalSummary = () =>
  useQuery({
    queryKey: syloKeys.localSummary,
    queryFn: async () => summarise(unwrapRows(await customFetch<unknown>("/api/local-accounts"), "accounts")),
  });

export interface KycSummary extends AccountSummary { paid: number; unpaid: number }

export const useKycSummary = () =>
  useQuery({
    queryKey: syloKeys.kycSummary,
    queryFn: async (): Promise<KycSummary> => {
      const rows = unwrapRows(await customFetch<unknown>("/api/kyc-entries"), "entries");
      const base = summarise(rows);
      const paid = rows.filter((r) => r.paid === true).length;
      return { ...base, paid, unpaid: rows.length - paid };
    },
  });
