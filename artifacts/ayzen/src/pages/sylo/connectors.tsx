/**
 * pages/sylo/connectors.tsx — /vault/settings/connectors
 *
 * One place to link Sylo to the apps and modules around it. Only what the
 * backend can actually do is live: Google Drive and Dropbox use the existing
 * backup-cloud OAuth endpoints (lib/vault-snapshot-api.ts), and Skarn / Verve
 * open their own module hosts. Everything else is listed honestly as "Soon"
 * so the page never pretends a link works.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  connectCloudProvider, disconnectCloudProvider, listCloudConnections,
  type CloudProvider,
} from "@/lib/vault-snapshot-api";
import { moduleUrl } from "@/lib/subdomain-app";

type Tone = "ok" | "warn" | "bad" | "";
const Pill = ({ k = "", children }: { k?: Tone; children: React.ReactNode }) => <span className={`pill ${k}`}>{children}</span>;

function Row({ mark, name, desc, right }: { mark: string; name: string; desc: string; right: React.ReactNode }) {
  return (
    <div className="row" style={{ padding: "14px 18px" }}>
      <span className="mk">{mark}</span>
      <div className="g"><b>{name}</b><span style={{ fontFamily: "var(--sans)" }}>{desc}</span></div>
      {right}
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="card">
      <header><h3>{title}</h3><span>{count}</span></header>
      {children}
    </section>
  );
}

export default function SyloConnectors() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const cloud = useQuery({ queryKey: ["vault-backup-cloud"], queryFn: listCloudConnections });
  const byProvider = new Map((cloud.data?.connections ?? []).map((c) => [c.provider, c]));

  const connect = useMutation({
    mutationFn: (p: CloudProvider) => connectCloudProvider(p),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "Couldn’t start the connection."),
  });
  const disconnect = useMutation({
    mutationFn: (p: CloudProvider) => disconnectCloudProvider(p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vault-backup-cloud"] }),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "Couldn’t disconnect."),
  });

  const connected = (cloud.data?.connections ?? []).filter((c) => c.connected).length;

  const cloudRow = (provider: CloudProvider, mark: string, name: string, desc: string) => {
    const c = byProvider.get(provider);
    let right: React.ReactNode;
    if (cloud.isPending) right = <Pill>Checking</Pill>;
    else if (cloud.isError) right = <Pill k="bad">Unavailable</Pill>;
    else if (c?.connected) {
      right = (
        <>
          <Pill k="ok">{c.accountLabel ? `Connected · ${c.accountLabel}` : "Connected"}</Pill>
          <button type="button" className="btn" disabled={disconnect.isPending} onClick={() => disconnect.mutate(provider)}>Disconnect</button>
        </>
      );
    } else if (c && !c.configured) right = <Pill>Not set up on server</Pill>;
    else right = <button type="button" className="btn p" disabled={connect.isPending} onClick={() => connect.mutate(provider)}>Connect</button>;
    return <Row key={provider} mark={mark} name={name} desc={desc} right={right} />;
  };

  const moduleRow = (id: string, mark: string, name: string, desc: string) => (
    <Row key={id} mark={mark} name={name} desc={desc}
      right={<a className="btn" href={moduleUrl(id, "/")} target="_blank" rel="noreferrer">Open <ExternalLink size={13} aria-hidden="true" /></a>} />
  );

  const soon = (mark: string, name: string, desc: string) => (
    <Row key={name} mark={mark} name={name} desc={desc} right={<Pill>Soon</Pill>} />
  );

  return (
    <div className="stack">
      <div className="ph">
        <div>
          <div className="eb">Settings · Connectors</div>
          <h1>Connectors</h1>
          <p>Link Sylo to bots, apps and other modules. Each link can be removed at any time.</p>
        </div>
        <div className="acts"><Link href="/vault/snapshot" className="btn">Backup schedule</Link></div>
      </div>

      <div className="kpis">
        <div className="kpi" style={{ ["--c" as string]: "var(--slate)" }}><label>Cloud linked</label><strong>{cloud.isPending ? "…" : connected}</strong><small>of 2 backup targets</small></div>
        <div className="kpi" style={{ ["--c" as string]: "var(--slate)" }}><label>Modules</label><strong>2</strong><small>Skarn · Verve</small></div>
      </div>

      {error && <div className="note" role="alert"><b>Something went wrong.</b> {error}</div>}

      <Group title="Messaging" count={1}>
        {soon("TG", "Telegram bot", "Alerts, code requests and quick lookups from chat.")}
      </Group>
      <Group title="Apps" count={4}>
        {cloudRow("google_drive", "GD", "Google Drive", "Encrypted vault backups to your own Drive.")}
        {cloudRow("dropbox", "DB", "Dropbox", "Encrypted vault backups to your own Dropbox.")}
        {soon("GM", "Gmail", "Read verification mail into the mailbox view.")}
        {soon("GH", "GitHub", "Store deploy keys and sign-in recovery codes.")}
      </Group>
      <Group title="Modules" count={2}>
        {moduleRow("skarn", "SK", "Skarn", "Share entities and sign in with your vault identity.")}
        {moduleRow("verve", "VE", "Verve", "Use vault credentials inside Verve.")}
      </Group>
    </div>
  );
}
