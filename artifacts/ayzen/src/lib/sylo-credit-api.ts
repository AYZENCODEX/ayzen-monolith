/**
 * lib/sylo-credit-api.ts — typed client for Sylo's own credit storefront
 * (artifacts/api-server/src/routes/sylo-credit.ts). Kept separate from the
 * AYZEN-wide /credits endpoints on purpose: Sylo has its own price list,
 * orders and saved payment methods.
 */
import { customFetch } from "@workspace/api-client-react";

export type PayKind = "bkash" | "nagad" | "binance" | "wallet";
export const PAY_KINDS: { id: PayKind; label: string; mark: string; hint: string }[] = [
  { id: "bkash", label: "bKash", mark: "bK", hint: "Mobile number" },
  { id: "nagad", label: "Nagad", mark: "Ng", hint: "Mobile number" },
  { id: "binance", label: "Binance", mark: "BN", hint: "Binance Pay ID" },
  { id: "wallet", label: "Wallet", mark: "W", hint: "Wallet address" },
];
export const WALLET_NETWORKS = ["TRC20", "ERC20", "BEP20", "SOL", "BTC", "POLYGON"] as const;
export const payKindLabel = (k: string) => PAY_KINDS.find((p) => p.id === k)?.label ?? k;
/** bKash and Nagad settle in BDT; Binance and wallets settle in USD(T). */
export const payCurrency = (k: string): "BDT" | "USD" => (k === "bkash" || k === "nagad" ? "BDT" : "USD");

export interface Pricing { priceUsd: number; priceBdt: number; minAzn: number }
export interface Summary {
  aznBalance: number;
  creditBalance: number;
  pricing: Pricing;
  payTo: { bkash: string | null; nagad: string | null; binance: string | null; network: string };
  pendingOrders: number;
}
export interface PaymentMethod {
  id: number; kind: PayKind; label: string | null; account: string; network: string | null; isDefault: boolean; createdAt: string;
}
export type OrderStatus = "pending" | "approved" | "rejected";
export interface Order {
  id: number; orderNo: string; aznAmount: number; unitPriceUsd: number; unitPriceBdt: number;
  totalUsd: number; totalBdt: number; payKind: PayKind; payAccount: string; referenceId: string;
  status: OrderStatus; adminNote: string | null; approvedAt: string | null; createdAt: string;
}
export interface UsageEntry { id: number; type: string; credits: number; actionKey: string | null; notes: string | null; createdAt: string }
export interface Usage { balance: number; spent30d: number; byAction: { actionKey: string; spent: number; uses: number }[]; entries: UsageEntry[] }

const base = "/api/sylo/credit";
const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const syloCredit = {
  summary: () => customFetch<Summary>(`${base}/summary`),
  methods: () => customFetch<{ methods: PaymentMethod[] }>(`${base}/payment-methods`),
  addMethod: (b: { kind: PayKind; label?: string; account: string; network?: string; makeDefault?: boolean }) =>
    customFetch<{ method: PaymentMethod }>(`${base}/payment-methods`, { method: "POST", ...json(b) }),
  patchMethod: (id: number, b: { label?: string; makeDefault?: boolean }) =>
    customFetch<{ method: PaymentMethod }>(`${base}/payment-methods/${id}`, { method: "PATCH", ...json(b) }),
  removeMethod: (id: number) => customFetch<{ ok: true }>(`${base}/payment-methods/${id}`, { method: "DELETE" }),
  orders: () => customFetch<{ orders: Order[] }>(`${base}/orders`),
  order: (id: number | string) => customFetch<{ order: Order }>(`${base}/orders/${id}`),
  buy: (b: { aznAmount: number; paymentMethodId: number; referenceId: string }) =>
    customFetch<{ order: Order; message: string }>(`${base}/orders`, { method: "POST", ...json(b) }),
  usage: () => customFetch<Usage>(`${base}/usage`),
};

export const QK = {
  summary: ["sylo-credit", "summary"] as const,
  methods: ["sylo-credit", "methods"] as const,
  orders: ["sylo-credit", "orders"] as const,
  order: (id: string | number) => ["sylo-credit", "order", String(id)] as const,
  usage: ["sylo-credit", "usage"] as const,
};

/** Server 4xx bodies carry a user-safe `error` string; anything else gets generic copy. */
export function errorMessage(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === "string" && data.error ? data.error : fallback;
}

export const fmtAzn = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
export const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
export const fmtBdt = (n: number) => `৳${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtDate = (s: string) => new Date(s).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const maskAccount = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`);
