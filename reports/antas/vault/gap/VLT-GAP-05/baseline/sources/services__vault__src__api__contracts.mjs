export const VAULT_CONTRACT = Object.freeze({
  service: "vault",
  displayName: "Vault / SYLO",
  routePrefixes: ["/api/vault"],
  routes: [
    { method: "GET", path: "/api/vault/secrets", auth: "configured", response: "metadata list" },
    { method: "POST", path: "/api/vault/secrets", auth: "tenant scope", response: "created metadata" },
    { method: "GET", path: "/api/vault/secrets/:id", auth: "tenant + single-use step-up", response: "revealed secret" },
    { method: "GET", path: "/internal/audit", auth: "service internal", response: "audit list" },
  ],
  events: ["vault.secret.updated", "vault.secret.accessed"],
  ownedResources: ["vault_records", "vault_versions", "vault_access_audit"],
});
