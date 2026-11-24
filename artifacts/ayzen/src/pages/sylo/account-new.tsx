/**
 * pages/sylo/account-new.tsx — /vault/account/:section/new
 * and /vault/kyc/data/new  (Data entity)
 *
 * Create-as-a-page for Entity, Local, KYC, Game and KYC Data entities. Mobile
 * first: one scrolling form, a sticky Cancel / Save bar, no modal. Fields come
 * from the same config/fields/* definitions as the existing dialogs and every
 * kind posts the exact payload its dialog posts, so the API sees no difference.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Redirect, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import type { FieldDef } from "@/config/types";
import { ENTITY_FIELDS } from "@/config/fields/entity-create";
import { KYC_FIELDS } from "@/config/fields/kyc-create";
import { LOCAL_ACCOUNT_FIELDS } from "@/config/fields/local-account-create";
import { GAME_FIELDS } from "@/config/fields/game-create";
import { KYC_DATA_FIELDS } from "@/config/fields/kyc-data-create";
import { KYC_CATEGORIES } from "@/config/vault-kyc";
import { GAME_CATEGORIES } from "@/config/vault-game";
import { LOCAL_ACCOUNT_DEFAULT_CATEGORIES, getLocalAccountPlatformMeta } from "@/config/vault-local";
import { accountPath, isAccountSection, type AccountSection } from "@/lib/sylo-routes";

type Values = Record<string, any>;
interface Section { title: string; note?: string; fields: FieldDef[]; chips?: { key: string; options: string[]; required?: boolean } }
interface Kind {
  eyebrow: string; title: string; sub: string; cta: string; listLabel: string; listHref: string; tone: string;
  sections: Section[]; initial: Values;
  submit: (v: Values, key: string) => Promise<unknown>;
  validate?: (v: Values) => string | null;
  invalidate: string[];
}

const pick = (src: FieldDef[], f: (x: FieldDef) => boolean) => src.filter(f);
const only = (src: FieldDef[], keys: string[]) => keys.map((k) => src.find((f) => f.key === k)).filter(Boolean) as FieldDef[];
const blank = (fields: FieldDef[]) => Object.fromEntries(fields.map((f) => [f.key, f.type === "toggle" ? false : ""]));

/* ── Entity ──────────────────────────────────────────────────────────── */
const ENTITY_HEAD: FieldDef[] = [
  { key: "projectName", label: "Entity name", type: "text", placeholder: "Protocol / Project name", required: true },
  { key: "score", label: "Score (0–10)", type: "number", placeholder: "5" },
  { key: "tags", label: "Tags (comma separated)", type: "text", placeholder: "priority, airdrop" },
];
const platform = (tab: string) => pick(ENTITY_FIELDS, (f) => f.tab === tab);
const ENTITY_SECTIONS: Section[] = [
  { title: "Entity", fields: ENTITY_HEAD },
  { title: "Email", fields: [...only(ENTITY_FIELDS, ["email", "emailPassword", "email2fa", "emailBackupCode", "emailRecovery", "emailRecoveryPassword", "recovery2fa", "recoveryBackupCode"])] },
  { title: "Twitter", note: "optional", fields: platform("twitter") },
  { title: "Discord", note: "optional", fields: platform("discord") },
  { title: "Telegram", note: "optional", fields: platform("telegram") },
  { title: "Wallet", note: "optional", fields: only(ENTITY_FIELDS, ["walletAddresses", "backupCodes"]) },
];
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* ── KYC ─────────────────────────────────────────────────────────────── */
const kycOf = (tab: string, subtab: string) => pick(KYC_FIELDS, (f) => f.tab === tab && f.subtab === subtab);

const KINDS: Record<AccountSection | "kyc-data", Kind> = {
  entity: {
    eyebrow: "Entity · Add", title: "Add entity", sub: "Name it, then fill each platform’s credentials.", cta: "Save entity",
    listLabel: "Entity", listHref: accountPath("entity", "management"), tone: "brass",
    sections: ENTITY_SECTIONS,
    initial: { ...blank(ENTITY_SECTIONS.flatMap((s) => s.fields)), score: "5" },
    validate: (v) => (v.projectName?.trim() ? null : "Entity name is required."),
    submit: (v, key) => {
      const payload: Values = { projectName: v.projectName.trim() };
      for (const f of ENTITY_SECTIONS.flatMap((s) => s.fields)) {
        if (["projectName", "score", "tags", "walletAddresses", "backupCodes"].includes(f.key)) continue;
        if (v[f.key] !== "" && v[f.key] != null) payload[f.key] = f.type === "number" ? Number(v[f.key]) : v[f.key];
      }
      const lines = (s: string) => String(s).split("\n").map((x) => x.trim()).filter(Boolean);
      if (v.walletAddresses) payload.walletAddresses = lines(v.walletAddresses);
      if (v.backupCodes) payload.backupCodes = lines(v.backupCodes);
      payload.tags = String(v.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const sc = Number(v.score);
      payload.score = Number.isFinite(sc) ? Math.max(0, Math.min(10, Math.round(sc))) : 5;
      return customFetch("/api/vault", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) });
    },
    invalidate: ["/api/vault"],
  },
  local: {
    eyebrow: "Local · Add", title: "Add account", sub: "Pick a platform, then add credentials, dates and value.", cta: "Save account",
    listLabel: "Local accounts", listHref: accountPath("local", "management"), tone: "patina",
    sections: [
      { title: "Platform", fields: [{ key: "followers", label: "Metric", type: "text", placeholder: "e.g. 1200" }], chips: { key: "category", options: LOCAL_ACCOUNT_DEFAULT_CATEGORIES.map((c) => c.name), required: true } },
      { title: "Credentials", fields: pick(LOCAL_ACCOUNT_FIELDS, (f) => f.tab === "creds") },
      { title: "Dates & label", fields: pick(LOCAL_ACCOUNT_FIELDS, (f) => f.tab === "dates") },
      { title: "Value", fields: pick(LOCAL_ACCOUNT_FIELDS, (f) => f.tab === "value") },
    ],
    initial: { category: "", ...blank(LOCAL_ACCOUNT_FIELDS), followers: "", notes: "", score: "5" },
    validate: (v) => (v.category ? null : "Pick a platform."),
    submit: (v) => customFetch("/api/local-accounts", {
      method: "POST",
      body: JSON.stringify({
        category: v.category, label: v.label || null, username: v.username || null, email: v.email || null,
        password: v.password || null, recoveryEmail: v.recovery_email || null,
        recoveryEmailPassword: v.recovery_email_password || null, backupCodes: v.backup_codes || null,
        twofa: v.twofa || null, recoveryEmailTwofa: v.recovery_email_twofa || null, followers: v.followers || null,
        accountWorth: Number(v.account_worth) || 0, buyPrice: Number(v.buy_price) || 0,
        accountCreateDate: v.account_create_date || null, accountBuyDate: v.account_buy_date || null,
        accountLastLoginDate: v.account_last_login_date || null, notes: v.notes || null,
        score: Math.max(0, Math.min(10, Math.round(Number(v.score) || 5))),
      }),
    }),
    invalidate: ["/api/local-accounts"],
  },
  kyc: {
    eyebrow: "KYC · Add", title: "Add KYC entry", sub: "Pick the exchange, then account details and seller.", cta: "Save entry",
    listLabel: "KYC entries", listHref: accountPath("kyc", "management"), tone: "copper",
    sections: [
      { title: "Exchange", fields: [], chips: { key: "category", options: KYC_CATEGORIES.map((c) => c.name), required: true } },
      { title: "Account · Main", fields: kycOf("account", "main") },
      { title: "Account · Info", fields: kycOf("account", "info") },
      { title: "Account · Recovery", note: "optional", fields: kycOf("account", "recovery") },
      { title: "Seller", fields: kycOf("kyc", "seller") },
    ],
    initial: { category: "", ...blank(KYC_FIELDS), dataEntityId: null, paid: false },
    validate: (v) => (v.category ? null : "Pick an exchange."),
    submit: (v) => customFetch("/api/kyc-entries", { method: "POST", body: JSON.stringify(v) }),
    invalidate: ["/api/kyc-entries"],
  },
  game: {
    eyebrow: "Game · Add", title: "Add game account", sub: "Pick the platform, then account, email and info.", cta: "Save account",
    listLabel: "Game accounts", listHref: accountPath("game", "management"), tone: "slate",
    sections: [
      { title: "Platform", fields: [], chips: { key: "category", options: GAME_CATEGORIES.map((c) => c.name), required: true } },
      { title: "Account", fields: pick(GAME_FIELDS, (f) => f.tab === "account") },
      { title: "Email", fields: pick(GAME_FIELDS, (f) => f.tab === "email") },
      { title: "Info", fields: pick(GAME_FIELDS, (f) => f.tab === "info" && f.key !== "tags").concat({ key: "tags", label: "Tags (comma separated)", type: "text", placeholder: "inventory, prime" }) },
    ],
    initial: { category: "", ...blank(GAME_FIELDS), tags: "" },
    validate: (v) => (v.category ? null : "Pick a platform."),
    submit: (v) => customFetch("/api/game-entries", {
      method: "POST",
      body: JSON.stringify({ ...v, tags: String(v.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean) }),
    }),
    invalidate: ["/api/game-entries"],
  },
  "kyc-data": {
    eyebrow: "KYC · Data entity · Add", title: "Add data entity", sub: "Identity details a KYC entry can link to.", cta: "Save data entity",
    listLabel: "Data entity", listHref: "/vault/kyc/data/overview", tone: "copper",
    sections: [
      { title: "Identity", fields: pick(KYC_DATA_FIELDS, (f) => f.type !== "image" && f.key !== "notes") },
      { title: "Photos", note: "image URLs", fields: pick(KYC_DATA_FIELDS, (f) => f.type === "image").map((f) => ({ ...f, type: "text" as const, placeholder: "https://…" })) },
      { title: "Notes", fields: pick(KYC_DATA_FIELDS, (f) => f.key === "notes") },
    ],
    initial: blank(KYC_DATA_FIELDS),
    submit: (v) => customFetch("/api/kyc-data-entities", { method: "POST", body: JSON.stringify(v) }),
    invalidate: ["/api/kyc-data-entities"],
  },
};

/* ── Rendering ───────────────────────────────────────────────────────── */
function Field({ f, value, onChange, error }: { f: FieldDef; value: any; onChange: (v: any) => void; error?: boolean }) {
  const id = `f-${f.key}`;
  const common = { id, value: value ?? "", placeholder: f.placeholder, "aria-invalid": error || undefined } as const;
  let input: ReactNode;
  if (f.type === "textarea") input = <textarea {...common} rows={f.rows ?? 3} onChange={(e) => onChange(e.target.value)} />;
  else if (f.type === "toggle") {
    return (
      <div className="row" style={{ padding: "12px 0" }}>
        <div className="g"><b style={{ fontWeight: 500 }}>{f.label}</b></div>
        <button type="button" role="switch" aria-checked={!!value} aria-label={f.label} className={`tgl ${value ? "on" : ""}`} onClick={() => onChange(!value)}><i /></button>
      </div>
    );
  } else {
    const type = f.type === "password" ? "password" : f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
    input = <input {...common} type={type} step={f.type === "number" ? "any" : undefined} autoComplete="off" onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={`fld ${error ? "bad" : ""}`}>
      <label htmlFor={id}>{f.label}{f.required && <span className="req">*</span>}</label>
      <div className={`in ${f.type === "textarea" ? "ta" : ""}`} style={{ color: "var(--tx)" }}>{input}</div>
    </div>
  );
}

function Fields({ fields, values, set }: { fields: FieldDef[]; values: Values; set: (k: string, v: any) => void }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const next = fields[i + 1];
    if (f.pairKey && next?.pairKey === f.pairKey) {
      out.push(
        <div className="two" key={f.key}>
          <Field f={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
          <Field f={next} value={values[next.key]} onChange={(v) => set(next.key, v)} />
        </div>,
      );
      i++;
    } else out.push(<Field key={f.key} f={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />);
  }
  return <>{out}</>;
}

export default function SyloAccountNew({ kindOverride }: { kindOverride?: "kyc-data" }) {
  const params = useParams<{ section?: string }>();
  const kindKey = kindOverride ?? (isAccountSection(params.section) ? params.section : undefined);
  if (!kindKey) return <Redirect to="/vault" />;
  return <Form kindKey={kindKey} />;
}

function Form({ kindKey }: { kindKey: AccountSection | "kyc-data" }) {
  const kind = KINDS[kindKey];
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [values, setValues] = useState<Values>(kind.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(newKey());
  const set = useMemo(() => (k: string, v: any) => setValues((p) => ({ ...p, [k]: v })), []);

  const save = async () => {
    const problem = kind.validate?.(values) ?? null;
    if (problem) { setError(problem); return; }
    setError(null);
    setSaving(true);
    try {
      await kind.submit(values, idem.current);
      await Promise.all(kind.invalidate.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast({ title: "Saved to vault" });
      navigate(kind.listHref);
    } catch {
      setError("Couldn’t save. Nothing was changed. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`stack t-${kind.tone}`}>
      <Link href={kind.listHref} className="back">‹ {kind.listLabel}</Link>
      <div className="ph"><div><div className="eb">{kind.eyebrow}</div><h1>{kind.title}</h1><p>{kind.sub}</p></div></div>

      {kind.sections.map((s) => (
        <div className="mb" key={s.title}>
          <section className="card">
            <header><h3>{s.title}</h3><span>{s.note ?? ""}</span></header>
            <div className="body">
              {s.chips && (
                <div role="radiogroup" aria-label={s.title} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: s.fields.length ? 14 : 0 }}>
                  {s.chips.options.map((o) => (
                    <button type="button" role="radio" aria-checked={values[s.chips!.key] === o} key={o}
                      className={`chip ${values[s.chips!.key] === o ? "on" : ""}`} onClick={() => set(s.chips!.key, o)}>{o}</button>
                  ))}
                </div>
              )}
              <Fields fields={s.fields} values={values} set={set} />
              {s.title === "Platform" && kindKey === "local" && values.category && (
                <div className="hint" style={{ marginTop: -6 }}>{getLocalAccountPlatformMeta(values.category).tips.join(" · ")}</div>
              )}
            </div>
          </section>
        </div>
      ))}

      {error && <div className="note" role="alert"><b>{error}</b></div>}

      <div className="actionbar">
        <Link href={kind.listHref} className="btn">Cancel</Link>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn p" disabled={saving} onClick={save}>{saving ? "Saving…" : kind.cta}</button>
      </div>
    </div>
  );
}
