import crypto from "node:crypto";
import { iso, type InMemoryNewEngineStore } from "./store";
import type { ConsentCheck, ConsentGrant, ConsentVersion } from "./types";

export class ConsentEngine {
  constructor(private readonly store: InMemoryNewEngineStore) {}

  registerVersion(input: Omit<ConsentVersion, "createdAt"> & { createdAt?: string }): ConsentVersion {
    const versions = this.store.consentVersions.get(input.consentType) ?? [];
    if (versions.some((version) => version.version === input.version)) throw new Error(`Consent version already exists: ${input.consentType} v${input.version}`);
    const version = { ...input, requiredScopes: [...new Set(input.requiredScopes)], createdAt: input.createdAt ?? iso() };
    versions.push(version);
    versions.sort((a, b) => a.version - b.version);
    this.store.consentVersions.set(input.consentType, versions);
    return version;
  }

  grant(input: Omit<ConsentGrant, "id" | "grantedAt" | "withdrawnAt"> & { id?: string; grantedAt?: string }): ConsentGrant {
    const version = (this.store.consentVersions.get(input.consentType) ?? []).find((item) => item.version === input.version);
    if (!version) throw new Error(`Consent definition not found: ${input.consentType} v${input.version}`);
    const existing = [...this.store.consentGrants.values()].find((grant) =>
      grant.subjectId === input.subjectId && grant.organizationId === input.organizationId &&
      grant.consentType === input.consentType && grant.version === input.version && !grant.withdrawnAt,
    );
    if (existing) return existing;
    const grant = { ...input, id: input.id ?? crypto.randomUUID(), grantedAt: input.grantedAt ?? iso() };
    this.store.consentGrants.set(grant.id, grant);
    return grant;
  }

  withdraw(id: string, at = new Date()): ConsentGrant {
    const grant = this.store.consentGrants.get(id);
    if (!grant) throw new Error("Consent grant not found");
    if (!grant.withdrawnAt) grant.withdrawnAt = iso(at);
    return grant;
  }

  check(subjectId: string, consentType: string, scopes: string[] = [], organizationId?: number, at = new Date()): ConsentCheck {
    const candidates = [...this.store.consentGrants.values()]
      .filter((grant) => grant.subjectId === subjectId && grant.consentType === consentType && grant.organizationId === organizationId)
      .sort((a, b) => b.version - a.version || b.grantedAt.localeCompare(a.grantedAt));
    const grant = candidates[0];
    if (!grant) return { granted: false, reason: "NOT_FOUND" };
    if (grant.withdrawnAt) return { granted: false, grant, reason: "WITHDRAWN" };
    if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= at.getTime()) return { granted: false, grant, reason: "EXPIRED" };
    if (!scopes.every((scope) => grant.scopes.includes(scope))) return { granted: false, grant, reason: "SCOPE_MISSING" };
    return { granted: true, grant, reason: "ACTIVE" };
  }

  history(subjectId: string, consentType?: string): ConsentGrant[] {
    return [...this.store.consentGrants.values()]
      .filter((grant) => grant.subjectId === subjectId && (!consentType || grant.consentType === consentType))
      .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
  }
}