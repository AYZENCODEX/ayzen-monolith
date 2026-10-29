/**
 * vault/shared — Vault logic that other apps integrate with (marketplace today; wallet, mail, … later).
 * Cross-app routes live in routes/ as thin adapters and delegate here; SQL goes through
 * vault/infrastructure/repositories, authorization through vault/security.
 */
export * from "./marketplace/use-cases";
