/**
 * marketplace/admin/domain/settings.ts
 * MKT-05f: the parameter rule of PATCH /marketplace/settings, moved verbatim. A missing (undefined or null) fee_pct falls back to
 * the P2P default, a missing enabled falls back to true. No validation, as before.
 */
import { DEFAULT_FEE_PCT } from "../../kernel/domain/fee-policy";

export interface SettingsInput { fee_pct?: any; enabled?: any }
export const defaultSettings = (): { fee_pct: number; enabled: boolean } => ({ fee_pct: DEFAULT_FEE_PCT.p2p, enabled: true });
export const settingsParams = (input: SettingsInput): any[] => [input.fee_pct ?? DEFAULT_FEE_PCT.p2p, input.enabled ?? true];
