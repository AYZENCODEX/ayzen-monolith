/**
 * Entity gas/wallet address calculations. Extracted verbatim from
 * routes/vault.ts (VLT-GAP-01-B); pure domain rules with no I/O.
 */

export const ENTITY_GAS_CHAINS = ["ETH", "BASE", "MATIC", "BSC", "ARB", "OP"] as const;

export function addressesFor(entry: Record<string, unknown>): string[] {
  const walStr = (entry.wallet_addresses ?? entry.walletAddresses) as string | null | undefined;
  let addresses: string[] = [];
  try { addresses = walStr ? JSON.parse(walStr) : []; } catch { addresses = []; }
  const driveAddress = (entry.drive_wallet_address ?? entry.driveWalletAddress) as string | null | undefined;
  if (driveAddress) addresses = [...addresses, driveAddress];
  return addresses;
}
