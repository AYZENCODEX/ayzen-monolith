/**
 * Phase H10.2 — `config/eventbus/security.json`'s `restrictedPayloads`
 * (`["credentials", "tokens", "private-keys"]`) was Season 2 finding #9:
 * declared, validated for shape, never read by anything that actually
 * touches a payload. This is that reader.
 *
 * Each configured name is matched against payload keys case-insensitively
 * and tolerant of the punctuation/casing conventions already used
 * elsewhere in this repo's own field names (`private-keys` also catches
 * `privateKey` / `private_key` / `privateKeys`, not just a literal
 * dashed key) by stripping non-letters and singular/plural `s` before
 * comparing. This mirrors the existing `SENSITIVE_KEY` regex in
 * `@ayzen/audit` (secret/token/password/private/...) closely on purpose —
 * that one is hand-maintained prose; this one is config-driven so
 * `config/eventbus/security.json` stays the single place to add a new
 * restricted key without touching code.
 */
function normalizeKeyFragment(value) {
  return String(value).toLowerCase().replace(/[^a-z]/g, "").replace(/s$/, "");
}

function buildMatcher(restrictedPayloads = []) {
  const fragments = restrictedPayloads.map(normalizeKeyFragment).filter(Boolean);
  return (key) => {
    const normalized = normalizeKeyFragment(key);
    return fragments.some((fragment) => fragment && normalized.includes(fragment));
  };
}

/**
 * Walks a payload and replaces the value of any key matching a restricted
 * name with `"[redacted]"`, returning both the (possibly) redacted payload
 * and the list of key paths that were touched — callers use the list to
 * decide whether to log/audit, without needing to diff the payload
 * themselves. Redaction, not rejection: a payload that happens to include
 * a restricted-shaped field is far more often a legitimate field
 * (`refreshToken` on a `session.created` event, say) than an attack, and
 * this repo's own precedent (`@ayzen/audit`'s `redactAuditValue`,
 * `service-runtime`'s `createAuditLog`) is uniformly "strip the value,
 * keep the event", never "drop the whole record".
 */
export function redactRestrictedPayload(payload, restrictedPayloads = [], { depth = 0, path: keyPath = [] } = {}) {
  const matches = buildMatcher(restrictedPayloads);
  const touched = [];

  function walk(value, currentPath, level) {
    if (level > 8) return value;
    if (Array.isArray(value)) return value.map((item, index) => walk(item, [...currentPath, String(index)], level + 1));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const nextPath = [...currentPath, key];
      if (matches(key)) {
        touched.push(nextPath.join("."));
        return [key, "[redacted]"];
      }
      return [key, walk(item, nextPath, level + 1)];
    }));
  }

  const redacted = walk(payload, keyPath, depth);
  return { payload: redacted, redactedPaths: touched };
}

/** True if `payload` contains any key matching a restricted name, without
 * building the redacted copy — used for a cheap pre-check before deciding
 * whether an envelope even needs its payload replaced. */
export function payloadHasRestrictedKeys(payload, restrictedPayloads = []) {
  const matches = buildMatcher(restrictedPayloads);
  function walk(value, level) {
    if (level > 8 || !value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => walk(item, level + 1));
    return Object.entries(value).some(([key, item]) => matches(key) || walk(item, level + 1));
  }
  return walk(payload, 0);
}
