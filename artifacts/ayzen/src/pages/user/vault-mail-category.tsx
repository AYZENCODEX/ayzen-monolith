import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { Shield, Smartphone, ShieldCheck, Gamepad2, ChevronRight, Loader2, AtSign } from "lucide-react";
import {
  buildEntityMailItems, buildLocalMailItems, buildKycMailItems, buildGameMailItems,
  groupByEntity, type MailCategory,
} from "@/lib/vault-mail-items";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import { useModuleAwareNavigate } from "@/components/module-link";

const CATEGORY_META: Record<MailCategory, { label: string; icon: React.ElementType; desc: string }> = {
  kyc:    { label: "KYC",    icon: ShieldCheck, desc: "Emails from KYC entities" },
  local:  { label: "Local",  icon: Smartphone,  desc: "Emails from local accounts" },
  entity: { label: "Entity", icon: Shield,      desc: "Emails from vault entities" },
  game:   { label: "Game",   icon: Gamepad2,    desc: "Emails from game accounts" },
};

export default function VaultMailCategory() {
  const params = useParams<{ category: string }>();
  const navigate = useModuleAwareNavigate();
  // Guard against an unknown/stale category (e.g. a leftover "account" link)
  // silently falling through to the wrong endpoint/filter further down —
  // fall back to "entity" whenever the param isn't a real category.
  const rawCategory = params.category as MailCategory;
  const category: MailCategory = CATEGORY_META[rawCategory] ? rawCategory : "entity";
  const meta = CATEGORY_META[category];

  const { data: vaultData, isLoading: vaultLoading } = useListVaultEntries();
  const [raw, setRaw] = useState<any[]>([]);
  const [loading, setLoading] = useState(category !== "entity");

  useEffect(() => {
    if (category === "entity") return;
    const endpoint = category === "kyc" ? "/kyc-entries" : category === "game" ? "/game-entries" : "/local-accounts";
    setLoading(true);
    customFetch<any>(endpoint).then(d => setRaw(Array.isArray(d) ? d : (d?.accounts ?? [])))
      .catch(() => setRaw([])).finally(() => setLoading(false));
  }, [category]);

  const summaries = useMemo(() => {
    const items = category === "entity" ? buildEntityMailItems((vaultData as any[]) ?? [])
      : category === "local" ? buildLocalMailItems(raw)
      : category === "kyc" ? buildKycMailItems(raw)
      : buildGameMailItems(raw);
    return groupByEntity(items);
  }, [category, vaultData, raw]);

  const isLoading = category === "entity" ? vaultLoading : loading;

  return (
    <VaultSectionPage title={`Mail Hub · ${meta.label}`} description={meta.desc} icon={meta.icon}>
      <div className="card">
        {isLoading && <div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div>}
        {!isLoading && summaries.length === 0 && (
          <div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
            <b style={{ fontWeight: 500 }}>No {meta.label} entities with an email yet</b>
            <span style={{ fontFamily: "var(--sans)" }}>Addresses saved on an account show up here.</span>
          </div>
        )}
        {!isLoading && summaries.map(s => {
          const open = () => navigate(`/vault/mail-hub/${category}/${s.entityId}`);
          return (
            <div key={`${s.category}-${s.entityId}`} className="row go" role="link" tabIndex={0} onClick={open}
              onKeyDown={(e) => { if (e.key === "Enter") open(); }} style={{ padding: "14px 18px", cursor: "pointer" }}>
              <span className="mk">{(s.entityName.trim().slice(0, 2) || "··").toUpperCase()}</span>
              <div className="g">
                <b>{s.entityName}</b>
                <span>{s.items.length} address{s.items.length !== 1 ? "es" : ""} · {s.items.map(i => i.email).join(", ")}</span>
              </div>
            </div>
          );
        })}
      </div>
    </VaultSectionPage>
  );
}
