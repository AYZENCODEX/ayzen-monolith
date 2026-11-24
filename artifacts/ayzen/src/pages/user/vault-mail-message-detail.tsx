import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Mail, Loader2, User, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModuleAwareNavigate } from "@/components/module-link";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface StoredMessageDetail {
  id: number; from: string; to: string; subject: string; body: string | null; date: string | null;
}

export default function VaultMailMessage() {
  const params = useParams<{ category: string; id: string; msgId: string }>();
  const navigate = useModuleAwareNavigate();
  const { token } = useAuth();
  const [msg, setMsg] = useState<StoredMessageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${BASE}/api/mail-messages/${params.msgId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (!r.ok) throw new Error("Message not found");
        return r.json();
      })
      .then(setMsg)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.msgId, token]);

  return (
    <div className="stack page-enter">
      <button type="button" className="back" onClick={() => navigate(`/vault/mail-hub/${params.category}/${params.id}`)}>‹ Mail hub</button>
      <div className="ph"><div><div className="eb">Mail hub</div><h1>Email</h1></div></div>

      {loading ? (
        <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>
      ) : error || !msg ? (
        <div className="card"><div className="row" style={{ padding: "26px 18px" }} role="alert"><div className="g"><b>{error ?? "Message not found"}</b></div></div></div>
      ) : (
        <div className="bg-card border border-card-border rounded-xl p-5 space-y-4">
          <div className="space-y-1.5">
            <h2 className="font-mono text-sm font-bold">{msg.subject || "(no subject)"}</h2>
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/60">
              <User className="w-3 h-3" /> {msg.from}
            </div>
            {msg.date && (
              <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/40">
                <Calendar className="w-3 h-3" /> {new Date(msg.date).toLocaleString()}
              </div>
            )}
          </div>
          <div className="border-t border-border/40 pt-4">
            <pre className="font-mono text-xs whitespace-pre-wrap break-words text-foreground/90 leading-relaxed">
              {msg.body || "(empty body — try Sync from the entity page to refetch)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
