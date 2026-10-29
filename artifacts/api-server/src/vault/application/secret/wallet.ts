import { formatVaultEntry as formatRow } from "../entity";
import { logVaultActivity } from "../entity";
import { selectVaultOne } from "../../infrastructure/repositories/entity-repository";
import { updateVaultDriveWallet, updateVaultWalletWorth } from "../../infrastructure/repositories/secret-repository";
import type { SecretResult } from "./reveal";

/**
 * Wallet use-cases attached to a vault entry (VLT-GAP-05-B). Bodies moved unchanged from
 * routes/vault.ts: PATCH /vault/:id/drive-wallet, POST /vault/validate-key and
 * POST /vault/:id/refresh-wallet-worth — same validation order, same persistence calls, same
 * activity entries, same error bodies and status codes.
 */

// PATCH /vault/:id/drive-wallet — set the fixed Drive wallet record.
// Wallet → Drive is a one-time, unedited fixed record (per spec): once set,
// it can never be changed or cleared through this endpoint.
export async function setDriveWallet(userId: number, idParam: string | string[], body: unknown): Promise<SecretResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
  const { label, address, note } = body as any;
  if (!address || !String(address).trim()) return { status: 400, body: { error: "Wallet address is required" } };

  const entry = await selectVaultOne(id, userId);
  if (!entry) return { status: 404, body: { error: "Vault entry not found" } };
  const alreadySet = entry.drive_wallet_set_at ?? (entry as any).driveWalletSetAt ?? entry.drive_wallet_address ?? (entry as any).driveWalletAddress;
  if (alreadySet) return { status: 409, body: { error: "Drive wallet is already set and cannot be edited" } };

  try {
    const row = await updateVaultDriveWallet(id, userId, { label, address, note });
    if (!row) return { status: 404, body: { error: "Vault entry not found" } };
    logVaultActivity(id, userId, "drive_wallet_set");
    return { status: 200, body: formatRow(row as unknown as Record<string, unknown>) };
  } catch (err: any) {
    return { status: 500, body: { error: "Unable to save drive wallet", detail: err?.message } };
  }
}

// POST /vault/validate-key — pre-save seed phrase / private key check.
// Validates the credential entered in the entity form's "Add Private Key"
// field *before* it gets encrypted and saved. Pure offline BIP-39 / secp256k1
// check — see lib/wallet-key-validation.ts. No entity id needed.
export async function validateSecretKey(body: unknown): Promise<SecretResult> {
  const { value } = body as { value?: string };
  if (typeof value !== "string" || !value.trim()) {
    return { status: 400, body: { error: "value is required" } };
  }
  const { validateWalletKey } = await import("../../../lib/wallet-key-validation");
  return { status: 200, body: validateWalletKey(value) };
}

// POST /vault/:id/refresh-wallet-worth — live multi-chain balance pull.
// Reads every address in walletAddresses + driveWalletAddress, checks each one
// against ETH/BASE/MATIC/BSC/ARB/OP via read-only RPC, sums native-coin USD value,
// and stores it on walletWorthUsd.
export async function refreshWalletWorth(userId: number, idParam: string | string[]): Promise<SecretResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);

  const entry = await selectVaultOne(id, userId);
  if (!entry) return { status: 404, body: { error: "Vault entry not found" } };

  const rawWalletAddresses = (entry as any).wallet_addresses ?? (entry as any).walletAddresses;
  let addresses: string[] = [];
  try { addresses = rawWalletAddresses ? JSON.parse(rawWalletAddresses as string) : []; } catch { addresses = []; }
  const driveAddress = (entry as any).drive_wallet_address ?? (entry as any).driveWalletAddress;
  if (driveAddress) addresses = [...addresses, driveAddress];

  if (addresses.length === 0) {
    return { status: 400, body: { error: "This entity has no wallet addresses to check" } };
  }

  try {
    const { getMultiChainWalletWorth } = await import("../../../lib/chain-balance");
    const summary = await getMultiChainWalletWorth(addresses);

    const row = await updateVaultWalletWorth(id, userId, summary.totalUsd);
    if (!row) return { status: 404, body: { error: "Vault entry not found" } };

    logVaultActivity(id, userId, "wallet_worth_refreshed");
    return {
      status: 200,
      body: {
        walletWorthUsd: summary.totalUsd,
        walletWorthSyncedAt: (row as any).walletWorthSyncedAt,
        breakdown: summary.results.filter((r) => r.balance > 0 || r.error),
      },
    };
  } catch (err: any) {
    return { status: 500, body: { error: "Unable to refresh live wallet worth", detail: err?.message } };
  }
}
