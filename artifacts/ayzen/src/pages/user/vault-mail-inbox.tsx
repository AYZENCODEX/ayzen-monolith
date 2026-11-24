import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useModuleAwareNavigate } from "@/components/module-link";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface InboxMessage {
  uid: number; seqno: number; seen: boolean;
  date: string; from: string; to: string; subject: string;
}

interface EmailAccount {
  id: number;
  label: string;
  emailAddress: string;
  provider?: string | null;
  imapHost?: string | null;
  imapPort?: number | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  useSSL: boolean;
  isDefault: boolean;
}

function formatFrom(from: string) {
  const match = from.match(/"?([^"<]+)"?\s*<?([^>]*)>?/);
  return match ? { name: match[1].trim(), email: match[2].trim() } : { name: from, email: "" };
}

function formatDate(dateStr: string) {
  try { return new Date(dateStr).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return dateStr; }
}

// ─── Full-page mailbox: lists messages for one configured account ─────────────
export default function VaultMailInbox() {
  const params = useParams<{ accountId: string }>();
  const navigate = useModuleAwareNavigate();
  const { token } = useAuth();

  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const accountId = params.accountId;

  useEffect(() => {
    setAccountLoading(true);
    fetch(`${BASE}/api/email-accounts/${accountId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(setAccount)
      .catch(() => setAccount(null))
      .finally(() => setAccountLoading(false));
  }, [accountId, token]);

  const fetchInbox = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${BASE}/api/email-accounts/${accountId}/fetch-inbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ limit: 50 }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail ?? data.error ?? "Failed"); return; }
      setMessages(data.messages ?? []);
      setTotal(data.total ?? 0);
      setLoaded(true);
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally { setLoading(false); }
  }, [accountId, token]);

  // Auto-load the inbox the moment we land on the full page.
  useEffect(() => {
    if (!accountLoading && account) fetchInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountLoading, account]);

  const unread = messages.filter(m => !m.seen).length;

  const goBack = () => navigate("/vault?tab=mail&view=mail");

  if (accountLoading) {
    return <div className="stack"><div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div></div>;
  }

  if (!account) {
    return (
      <div className="stack">
        <button type="button" className="back" onClick={goBack}>‹ Mail Hub</button>
        <div className="card"><div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
          <b style={{ fontWeight: 500 }}>Mail account not found</b>
        </div></div>
      </div>
    );
  }

  const notConfigured = !account.imapHost;

  return (
    <div className="stack t-brass page-enter">
      <button type="button" className="back" onClick={goBack}>‹ Mail Hub</button>
      <div className="ph">
        <div>
          <div className="eb">Mail · {account.label}</div>
          <h1 style={{ overflowWrap: "anywhere" }}>{account.emailAddress}</h1>
          <p>{account.provider ?? "custom"}{account.imapHost ? ` · ${account.imapHost}` : ""}</p>
        </div>
        <div className="acts">
          {account.imapHost && <span className="pill ok">IMAP</span>}
          {!notConfigured && (
            <button type="button" className="btn" onClick={fetchInbox} disabled={loading}>{loading ? "Fetching…" : "Refresh"}</button>
          )}
        </div>
      </div>

      {notConfigured ? (
        <div className="card"><div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
          <b style={{ fontWeight: 500 }}>This account isn't connected yet</b>
          <button type="button" className="btn" onClick={() => navigate("/vault?tab=mail&view=settings")}>Configure IMAP/SMTP</button>
        </div></div>
      ) : (
        <div className="card">
          <div className="tool">
            <span className="mono" style={{ flex: 1, fontSize: 11, color: "var(--mu)", letterSpacing: ".08em", textTransform: "uppercase" }}>
              Inbox{total > 0 ? ` · ${total} total` : ""}
            </span>
            {unread > 0 && <span className="pill warn">{unread} unread</span>}
          </div>

          {error && (
            <div className="note" role="alert" style={{ margin: 14 }}>
              <b>Connection failed.</b> {error}
              <div style={{ marginTop: 6, color: "var(--mu)" }}>Tip: Gmail requires an App Password (not your main password). Enable IMAP in Gmail Settings first.</div>
            </div>
          )}

          {loading && <div className="row" style={{ padding: "18px" }} role="status"><div className="g"><b>Connecting to IMAP…</b></div></div>}

          {!loading && !error && loaded && messages.length === 0 && (
            <div className="row" style={{ padding: "26px 18px" }}><div className="g"><b style={{ fontWeight: 500 }}>No messages in this mailbox</b></div></div>
          )}

          {!loading && messages.map(msg => {
            const from = formatFrom(msg.from);
            const open = () => navigate(`/vault/mail/${accountId}/${msg.seqno}`);
            return (
              <div key={msg.uid} className="row go" role="link" tabIndex={0} onClick={open}
                onKeyDown={(e) => { if (e.key === "Enter") open(); }} style={{ padding: "14px 18px", cursor: "pointer" }}>
                <span className="mk">{msg.seen ? "·" : "●"}</span>
                <div className="g">
                  <b style={{ fontWeight: msg.seen ? 400 : 500 }}>{from.name || from.email || msg.from}</b>
                  <span>{msg.subject}</span>
                </div>
                <span className="mono" style={{ color: "var(--di)", fontSize: 11 }}>{formatDate(msg.date)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
