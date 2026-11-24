/** pages/sylo/kyc-detail.tsx — /vault/kyc/:id (full tooling lives at /vault/kyc/:id/manage) */
import { useParams, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { NotFoundPage, InlineError } from "@/components/console";
import type { KycEntry } from "@/components/kyc-entries";
import { accountPath } from "@/lib/sylo-routes";
import { Back } from "./credit-ui";
import { EntryDetail, day, money, roi } from "./entry-detail";

export default function SyloKycDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const [, go] = useLocation();
  const qc = useQueryClient();
  const back = accountPath("kyc", "management");
  const q = useQuery({
    queryKey: ["sylo", "kyc", id],
    queryFn: () => customFetch<KycEntry>(`/api/kyc-entries/${encodeURIComponent(id)}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const del = useMutation({
    mutationFn: () => customFetch(`/api/kyc-entries/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sylo", "kyc"] }); go(back); },
  });

  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage embedded />;
  if (q.isPending) return <div className="stack" role="status"><Back href={back} label="KYC entries" /><div className="card"><div className="body">Loading…</div></div></div>;
  if (q.error || !q.data) return <div className="stack"><Back href={back} label="KYC entries" /><InlineError error={q.error} onRetry={() => void q.refetch()} /></div>;

  const k = q.data;
  const buy = k.account_buy_price ?? k.buy_price;
  return (
    <EntryDetail
      tone="t-copper" backHref={back} backLabel="KYC entries" eyebrow={`KYC · ${k.category}`}
      title={k.name || k.username || k.email || `Entry #${k.id}`}
      sub={[k.platform, k.location].filter(Boolean).join(" · ") || undefined}
      manageHref={`/vault/kyc/${k.id}/manage`}
      kpis={[
        ["Worth", money(k.account_worth) ?? "—", roi(k.account_worth, buy) ? `ROI ${roi(k.account_worth, buy)}` : undefined],
        ["Buy price", money(buy) ?? "—"],
        ["Followers", k.followers ?? "—"],
        ["Last login", day(k.last_login_at) ?? "—"],
      ]}
      sections={[
        { title: "Identity", rows: [
          { label: "Name", value: k.name }, { label: "Father", value: k.father_name },
          { label: "NID", value: k.nid_number, secret: true }, { label: "Birth date", value: day(k.birth_date) },
        ] },
        { title: "Credentials", rows: [
          { label: "Username", value: k.username }, { label: "Password", value: k.account_password, secret: true },
          { label: "2FA", value: k.account_2fa, secret: true }, { label: "Backup code", value: k.account_backup_code, secret: true },
          { label: "Email", value: k.email }, { label: "Email pass", value: k.email_password, secret: true },
          { label: "Email 2FA", value: k.email_2fa, secret: true }, { label: "Email backup", value: k.email_backup_code, secret: true },
          { label: "Recovery email", value: k.email_recovery }, { label: "Recovery pass", value: k.email_recovery_password, secret: true },
        ] },
        { title: "Dates", rows: [
          { label: "Created", value: day(k.account_create_date) }, { label: "Bought", value: day(k.account_buy_date) },
        ] },
        { title: "Notes", rows: [{ label: "Notes", value: k.notes }] },
      ]}
      onDelete={() => del.mutate()} deleting={del.isPending}
      deleteError={del.error ? "Couldn’t delete this entry. Try again." : null}
    />
  );
}
