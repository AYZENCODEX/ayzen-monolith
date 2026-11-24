import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { Shield, Smartphone, ShieldCheck, Gamepad2 } from "lucide-react";
import { TOTPCard } from "@/components/vault/totp-card";
import { useModuleAwareNavigate } from "@/components/module-link";

type Category = "kyc" | "local" | "entity" | "game";

const CATEGORY_META: Record<Category, { label: string; icon: React.ElementType }> = {
  kyc:    { label: "KYC",    icon: ShieldCheck },
  local:  { label: "Local",  icon: Smartphone },
  entity: { label: "Entity", icon: Shield },
  game:   { label: "Game",   icon: Gamepad2 },
};

interface TotpItem { id: string; label: string; issuer: string; secret: string; }

export default function VaultTwoFaEntity() {
  const params = useParams<{ category: string; id: string }>();
  const navigate = useModuleAwareNavigate();
  const category = (params.category as Category) ?? "entity";
  const id = Number(params.id);
  const meta = CATEGORY_META[category] ?? CATEGORY_META.entity;

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

  const { name, items }: { name: string; items: TotpItem[] } = useMemo(() => {
    if (category === "entity") {
      const e = ((vaultData as any[]) ?? []).find(x => x.id === id);
      if (!e) return { name: "", items: [] };
      const items: TotpItem[] = [];
      if (e.twitter2fa) items.push({ id: "tw", label: "Twitter", issuer: e.projectName, secret: e.twitter2fa });
      if (e.discord2fa) items.push({ id: "dc", label: "Discord", issuer: e.projectName, secret: e.discord2fa });
      if (e.telegram2fa) items.push({ id: "tg", label: "Telegram", issuer: e.projectName, secret: e.telegram2fa });
      return { name: e.projectName, items };
    }
    if (category === "local") {
      const a = raw.find(x => x.id === id);
      if (!a) return { name: "", items: [] };
      const items: TotpItem[] = [];
      if (a.twofa) items.push({ id: "main", label: "Main", issuer: a.email ?? "", secret: a.twofa });
      if (a.recovery_email_twofa) items.push({ id: "rec", label: "Recovery", issuer: a.recovery_email ?? "", secret: a.recovery_email_twofa });
      return { name: a.label ?? a.username ?? a.email ?? `Account #${a.id}`, items };
    }
    // kyc / game
    const e = raw.find(x => x.id === id);
    if (!e) return { name: "", items: [] };
    const items: TotpItem[] = e.email_2fa ? [{ id: "main", label: "Email", issuer: e.email ?? "", secret: e.email_2fa }] : [];
    return { name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`, items };
  }, [category, id, vaultData, raw]);

  const isLoading = category === "entity" ? vaultLoading : loading;

  return (
    <div className="stack t-brass page-enter">
      <button type="button" className="back" onClick={() => navigate(`/vault/2fa/${category}`)}>‹ 2FA</button>
      <div className="ph">
        <div>
          <div className="eb">2FA · {meta.label}</div>
          <h1>{name || "…"}</h1>
        </div>
      </div>

      {isLoading ? (
        <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>
      ) : items.length === 0 ? (
        <div className="card"><div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
          <b style={{ fontWeight: 500 }}>No 2FA codes found for this entity</b>
        </div></div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {items.map(item => (
            <TOTPCard key={item.id} label={item.label} issuer={item.issuer} secret={item.secret} />
          ))}
        </div>
      )}
    </div>
  );
}
