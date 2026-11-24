/**
 * vault-kyc-enrolled.tsx
 * ─────────────────────────────────────────────
 * Vault → KYC → Enrolled — now Overview/Active tabs (same hierarchy
 * pattern as the top-level Enroll sidebar's Projects/Entities pages —
 * components/layout/enroll-sidebar.tsx):
 *
 *   Overview — every KYC entity in the vault (GET /kyc-entries), each
 *              flagged Enrolled/Not enrolled against the enrollment list
 *              below, plus a small dashboard of enrollment stats.
 *   Active   — Exchange-platform (Binance/Bitget/Kucoin/Bybit) project
 *              enrollments created via the KYC-entity shortcut (pick a KYC
 *              Entity, no manual form — see kyc-entity-enroll-dialog.tsx).
 *              This is the original single-list view this page used to be.
 *              Backed by GET /kyc-entries/enrollments.
 */
import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import {
  ArrowLeftRight, IdCard, FolderGit2, Loader2,
  CheckCircle2, ShieldAlert, Ban, XCircle, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface EnrolledRow {
  enrollment_id: number;
  status: string;
  enrolled_at: string;
  project_id: number;
  project_name: string;
  project_type: string | null;
  thumbnail_url: string | null;
  kyc_entry_id: number;
  kyc_platform: string | null;
  kyc_username: string | null;
  vault_entry_id: number;
  vault_entry_name: string | null;
}

interface KycEntryRow {
  id: number;
  category: string;
  platform: string | null;
  username: string | null;
  name: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  active: "border-emerald-400/30 text-emerald-400",
  completed: "border-primary/30 text-primary",
  disqualified: "border-amber-400/30 text-amber-400",
  banned: "border-red-400/30 text-red-400",
  cancelled: "border-border text-muted-foreground",
};

const PILL: Record<string, string> = { active: " ok", completed: " ok", disqualified: " warn", banned: " bad", cancelled: "" };

const STATUS_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  active: { label: "Active", icon: CheckCircle2, color: "text-emerald-400" },
  completed: { label: "Completed", icon: CheckCircle2, color: "text-primary" },
  disqualified: { label: "Disqualified", icon: ShieldAlert, color: "text-amber-400" },
  banned: { label: "Banned", icon: Ban, color: "text-red-400" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "text-muted-foreground" },
};

function useEnrollmentData() {
  const [rows, setRows] = useState<EnrolledRow[]>([]);
  const [kycEntries, setKycEntries] = useState<KycEntryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [enrollments, entries] = await Promise.all([
        customFetch<EnrolledRow[]>("/api/kyc-entries/enrollments").catch(() => []),
        customFetch<KycEntryRow[]>("/api/kyc-entries").catch(() => []),
      ]);
      setRows(Array.isArray(enrollments) ? enrollments : []);
      setKycEntries(Array.isArray(entries) ? entries : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { rows, kycEntries, loading };
}

function StatCard({ label, value }: { label: string; value: string; icon?: React.ElementType; color?: string }) {
  return (
    <div className="kpi" style={{ ["--c" as string]: "var(--ac)" }}>
      <label>{label}</label><strong>{value}</strong><small>{" "}</small>
    </div>
  );
}

const Loading = () => <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>;
const Empty = ({ title, note }: { title: string; note: string }) => (
  <div className="card">
    <div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
      <b style={{ fontWeight: 500 }}>{title}</b><span style={{ fontFamily: "var(--sans)" }}>{note}</span>
    </div>
  </div>
);
const mk = (s: string) => (s.trim().slice(0, 2) || "··").toUpperCase();

function OverviewTab({ rows, kycEntries, loading }: { rows: EnrolledRow[]; kycEntries: KycEntryRow[]; loading: boolean }) {
  if (loading) return <Loading />;

  const enrolledEntryIds = new Set(rows.map(r => r.kyc_entry_id));
  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

  if (kycEntries.length === 0) {
    return (
      <Empty title="No KYC entities yet" note="Add a KYC entity to Vault and it'll show up here, flagged Enrolled once it's used on a project." />
    );
  }

  return (
    <div className="stack" style={{ maxWidth: "none" }}>
      <div className="kpis">
        <StatCard label="KYC entities" value={String(kycEntries.length)} />
        <StatCard label="Enrolled" value={String(enrolledEntryIds.size)} />
        <StatCard label="Not enrolled" value={String(kycEntries.length - enrolledEntryIds.size)} />
        {Object.entries(statusCounts).map(([status, count]) => {
          const meta = STATUS_META[status] ?? STATUS_META.cancelled;
          return <StatCard key={status} label={meta.label} value={String(count)} />;
        })}
      </div>

      <div className="card">
        {kycEntries.map(k => {
          const enrolled = enrolledEntryIds.has(k.id);
          const name = k.name || k.username || `KYC #${k.id}`;
          return (
            <Link key={k.id} href={`/vault/kyc/${k.id}`} className="row go" style={{ padding: "14px 18px" }}>
              <span className="mk">{mk(name)}</span>
              <div className="g"><b>{name}</b><span>{k.platform ?? k.category}</span></div>
              <span className={`pill${enrolled ? " ok" : ""}`}>{enrolled ? "Enrolled" : "Not enrolled"}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function ActiveTab({ rows, loading }: { rows: EnrolledRow[]; loading: boolean }) {
  if (loading) return <Loading />;

  if (rows.length === 0) {
    return (
      <Empty title="No KYC-entity enrollments yet" note={'Enroll into a Binance/Bitget/Kucoin/Bybit project using "KYC Entity" (not Manual) and it will show up here.'} />
    );
  }

  return (
    <div className="card">
      {rows.map(r => (
        <Link key={r.enrollment_id} href={`/vault/projects?project=${r.project_id}`} className="row go" style={{ padding: "14px 18px" }}>
          <span className="mk">{mk(r.project_name)}</span>
          <div className="g">
            <b>{r.project_name}</b>
            <span>{r.kyc_platform ?? "—"} · {r.kyc_username || `#${r.kyc_entry_id}`} · entity: {r.vault_entry_name || `#${r.vault_entry_id}`}</span>
          </div>
          <span className={`pill${PILL[r.status] ?? ""}`}>{r.status}</span>
        </Link>
      ))}
    </div>
  );
}

export default function VaultKycEnrolled() {
  const { rows, kycEntries, loading } = useEnrollmentData();
  const [tab, setTab] = useState<"overview" | "active">("overview");

  return (
    <VaultSectionPage
      title="Enrolled"
      description="Every KYC entity, plus the exchange projects enrolled straight from one"
      icon={ArrowLeftRight}
    >
      <div className="tabs">
        <button type="button" className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
        <button type="button" className={tab === "active" ? "on" : ""} onClick={() => setTab("active")}>Active</button>
      </div>
      {tab === "overview" ? <OverviewTab rows={rows} kycEntries={kycEntries} loading={loading} /> : <ActiveTab rows={rows} loading={loading} />}
    </VaultSectionPage>
  );
}
