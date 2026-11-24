/**
 * vault-banned.tsx
 * ─────────────────────────────────────────────
 * Vault → Other → Banned.
 *
 * Shows every banned account grouped by platform:
 *   • Twitter   — entity platform accounts with twitterBanned = true
 *   • Discord   — entity platform accounts with discordBanned = true
 *   • Telegram  — entity platform accounts with telegramBanned = true
 *   • Other     — custom "other" linked accounts with banned = true
 *   • Entity    — whole vault entities with status = "banned"
 *   • Local     — local accounts with status = "banned"
 *   • KYC       — KYC entities with status = "banned"
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import {
  Ban, Shield, User, ShieldCheck, Loader2, ChevronRight,
  Twitter, MessageCircle, Send, LayoutGrid,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { accountPath } from "@/lib/sylo-routes";

type EntryAny = any;

// ─── Sub-components ──────────────────────────────────────────────────────────

function PlatformHeader({ label, count }: {
  icon?: React.ElementType; label: string; count: number; color?: string;
}) {
  return (
    <div className="tool" style={{ borderTop: "1px solid var(--line)" }}>
      <b className="mono" style={{ flex: 1, fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--mu)", fontWeight: 500 }}>{label}</b>
      <span className="mono" style={{ color: "var(--di)", fontSize: 11 }}>{count} banned</span>
    </div>
  );
}

function BannedRow({ title, subtitle, onClick }: {
  icon?: React.ElementType; title: string; subtitle?: string; onClick?: () => void;
}) {
  const body = (
    <>
      <span className="mk">{(title.trim().slice(0, 2) || "··").toUpperCase()}</span>
      <div className="g"><b>{title}</b>{subtitle && <span>{subtitle}</span>}</div>
      <span className="pill bad">Banned</span>
    </>
  );
  return onClick
    ? <div className="row go" role="link" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === "Enter") onClick(); }} style={{ padding: "14px 18px", cursor: "pointer" }}>{body}</div>
    : <div className="row" style={{ padding: "14px 18px" }}>{body}</div>;
}

// ─── Platform groups ──────────────────────────────────────────────────────────

interface PlatformGroup {
  id: string;
  label: string;
  icon: React.ElementType;
  color: string;
  rows: { id: string; title: string; subtitle?: string; navigate: string }[];
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function VaultBanned() {
  const [, navigate] = useLocation();
  const { data: vaultData, isLoading: entitiesLoading } = useListVaultEntries();
  const [localAccounts, setLocalAccounts] = useState<EntryAny[]>([]);
  const [kycEntries, setKycEntries] = useState<EntryAny[]>([]);
  const [loadingOthers, setLoadingOthers] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingOthers(true);
      try {
        const [local, kyc] = await Promise.all([
          customFetch<EntryAny[]>("/api/local-accounts").catch(() => []),
          customFetch<EntryAny[]>("/api/kyc-entries").catch(() => []),
        ]);
        if (!cancelled) {
          setLocalAccounts(Array.isArray(local) ? local : []);
          setKycEntries(Array.isArray(kyc) ? kyc : []);
        }
      } finally {
        if (!cancelled) setLoadingOthers(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const entities: EntryAny[] = (vaultData as EntryAny[] | undefined) ?? [];

  // ── Platform ban groups (Twitter / Discord / Telegram / Other) ──────────
  const groups: PlatformGroup[] = [
    {
      id: "twitter", label: "Twitter", icon: Twitter, color: "blue",
      rows: entities
        .filter(e => e.twitterBanned && e.twitterUsername)
        .map(e => ({
          id: `tw-${e.id}`,
          title: `@${e.twitterUsername}`,
          subtitle: `Entity: ${e.projectName || `#${e.id}`}`,
          navigate: `/vault/entity/${e.id}`,
        })),
    },
    {
      id: "discord", label: "Discord", icon: MessageCircle, color: "indigo",
      rows: entities
        .filter(e => e.discordBanned && e.discordUsername)
        .map(e => ({
          id: `dc-${e.id}`,
          title: e.discordUsername,
          subtitle: `Entity: ${e.projectName || `#${e.id}`}`,
          navigate: `/vault/entity/${e.id}`,
        })),
    },
    {
      id: "telegram", label: "Telegram", icon: Send, color: "cyan",
      rows: entities
        .filter(e => e.telegramBanned && (e.telegramUsername || e.telegramPhone))
        .map(e => ({
          id: `tg-${e.id}`,
          title: e.telegramUsername ? `@${e.telegramUsername}` : e.telegramPhone,
          subtitle: `Entity: ${e.projectName || `#${e.id}`}`,
          navigate: `/vault/entity/${e.id}`,
        })),
    },
    {
      id: "other", label: "Other Platforms", icon: LayoutGrid, color: "zinc",
      rows: entities.flatMap(e => {
        if (!e.otherAccounts) return [];
        try {
          const arr = JSON.parse(e.otherAccounts);
          if (!Array.isArray(arr)) return [];
          return arr
            .filter((a: any) => a?.banned)
            .map((a: any, i: number) => ({
              id: `ot-${e.id}-${i}`,
              title: a.platform || "Other",
              subtitle: `Entity: ${e.projectName || `#${e.id}`}`,
              navigate: `/vault/entity/${e.id}`,
            }));
        } catch { return []; }
      }),
    },
    {
      id: "entity", label: "Whole Entities", icon: Shield, color: "red",
      rows: entities
        .filter(e => e.status === "banned")
        .map(e => ({
          id: `ent-${e.id}`,
          title: e.projectName || `Entity #${e.id}`,
          subtitle: e.entitySerial ?? "",
          navigate: `/vault/entity/${e.id}`,
        })),
    },
    {
      id: "local", label: "Local Accounts", icon: User, color: "zinc",
      rows: localAccounts
        .filter(a => a.status === "banned")
        .map(a => ({
          id: `loc-${a.id}`,
          title: a.label || a.username || a.email || `Account #${a.id}`,
          subtitle: a.category,
          navigate: `/vault/local/${a.id}`,
        })),
    },
    {
      id: "kyc", label: "KYC Entities", icon: ShieldCheck, color: "zinc",
      rows: kycEntries
        .filter(k => k.status === "banned")
        .map(k => ({
          id: `kyc-${k.id}`,
          title: k.name || k.username || `KYC #${k.id}`,
          subtitle: k.nid_number ? `NID: ${k.nid_number}` : k.category,
          navigate: accountPath("kyc", "management"),
        })),
    },
  ].filter(g => g.rows.length > 0);

  const loading = entitiesLoading || loadingOthers;
  const total = groups.reduce((s, g) => s + g.rows.length, 0);

  return (
    <VaultSectionPage title="Banned" description="All banned accounts, grouped by platform" icon={Ban}>
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      ) : total === 0 ? (
        <VaultSectionEmptyState
          icon={Ban}
          title="Nothing banned"
          note="Ban an entity, local account, KYC entity, or an individual linked platform account and it'll show up here, grouped by platform."
        />
      ) : (
        <div className="card">
          {groups.map(g => (
            <div key={g.id} style={{ display: "contents" }}>
              <PlatformHeader icon={g.icon} label={g.label} count={g.rows.length} color={g.color} />
              {g.rows.map(row => (
                <BannedRow
                  key={row.id}
                  icon={g.icon}
                  title={row.title}
                  subtitle={row.subtitle}
                  onClick={() => navigate(row.navigate)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </VaultSectionPage>
  );
}
