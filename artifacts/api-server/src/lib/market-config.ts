// MKT-03: moved to marketplace/kernel/infrastructure/market-config-repo.ts. This file only re-exports it so existing
// importers (vault use cases, routes/marketplace-market-config.ts) keep working unchanged.
export * from "../marketplace/kernel/infrastructure/market-config-repo";
