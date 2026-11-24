/**
 * vault-emergency-access.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 16 — Emergency Access / Dead-Man Switch.
 *
 * Owner-facing half of routes/emergency-access.ts: nominate trusted
 * contacts with an inactivity threshold, see any grants the dead-man-switch
 * cron has triggered, and cancel a grant (proof of life) before an admin
 * acts on it. The contact's confirm/view links and the admin review queue
 * live outside this page (public token links, admin console respectively).
 */
import { useEffect, useState } from "react";
import { HeartPulse, Plus, Trash2, Loader2, Clock, ShieldAlert, XCircle, Mail } from "lucide-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  listEmergencyContacts, addEmergencyContact, revokeEmergencyContact,
  listEmergencyGrants, cancelEmergencyGrant,
  type EmergencyContact, type EmergencyAccessGrant,
} from "@/lib/emergency-access-api";

const GRANT_STATUS_LABEL: Record<EmergencyAccessGrant["status"], string> = {
  pending_admin_review: "Pending admin review",
  approved: "Approved — access granted",
  denied: "Denied",
  cancelled: "Cancelled by you",
  expired: "Expired",
  revoked: "Revoked",
};

export default function VaultEmergencyAccess() {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [grants, setGrants] = useState<EmergencyAccessGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  function refresh() {
    setLoading(true);
    Promise.all([listEmergencyContacts(), listEmergencyGrants()])
      .then(([c, g]) => { setContacts(c.items); setGrants(g.items); })
      .catch(() => toast({ title: "Couldn't load emergency access settings", variant: "destructive" }))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, []);

  async function handleRevoke(id: number) {
    try {
      await revokeEmergencyContact(id);
      toast({ title: "Contact revoked" });
      refresh();
    } catch {
      toast({ title: "Couldn't revoke contact", variant: "destructive" });
    }
  }

  async function handleCancelGrant(id: number) {
    try {
      await cancelEmergencyGrant(id);
      toast({ title: "Request cancelled", description: "Good to know you're okay — the pending grant has been cancelled." });
      refresh();
    } catch {
      toast({ title: "Couldn't cancel this request", variant: "destructive" });
    }
  }

  const pendingGrants = grants.filter(g => g.status === "pending_admin_review");
  const otherGrants = grants.filter(g => g.status !== "pending_admin_review");

  return (
    <VaultSectionPage
      title="Emergency Access"
      description="Nominate a trusted contact who can request access if you go inactive"
      icon={HeartPulse}
      headerExtra={<button type="button" className="btn p" onClick={() => setAddOpen(true)}>+ Add contact</button>}
    >
      {loading ? (
        <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>
      ) : (
        <div className="stack">
          {pendingGrants.map(g => {
            const contact = contacts.find(c => c.id === g.contactId);
            return (
              <div key={g.id} className="note" role="alert" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <b>Emergency access triggered</b>
                  {contact?.contactName ?? "A nominated contact"} is eligible after inactivity. Triggered {new Date(g.triggeredAt).toLocaleString()}.
                  Still needs admin approval — cancel below if you're okay.
                </div>
                <button type="button" className="btn sm" onClick={() => handleCancelGrant(g.id)}>I'm here — cancel</button>
              </div>
            );
          })}

          <div className="card">
            <header><h3>Trusted contacts</h3><span>{contacts.length}</span></header>
            <p style={{ margin: 0, padding: "12px 18px", color: "var(--mu)", fontFamily: "var(--sans)", borderBottom: "1px solid var(--line)" }}>
              If you're inactive past a contact's wait period, they become eligible to request vault
              access — final access still requires admin approval.
            </p>
            {contacts.length === 0 ? (
              <VaultSectionEmptyState
                icon={HeartPulse}
                title="No trusted contacts yet"
                note="Add a contact so someone you trust can request access if something happens to you."
              />
            ) : contacts.map(c => (
              <div key={c.id} className="row" style={{ padding: "14px 18px", gap: 12, flexWrap: "wrap" }}>
                <span className="mk">{(c.contactName.trim().slice(0, 2) || "··").toUpperCase()}</span>
                <div className="g"><b>{c.contactName}</b><span>{c.contactEmail} · waits {c.waitDays}d</span></div>
                <span className={`pill${c.confirmedAt ? " ok" : ""}`}>{c.confirmedAt ? "Confirmed" : "Awaiting confirmation"}</span>
                {c.status === "active" && (
                  <button type="button" className="btn sm g" onClick={() => handleRevoke(c.id)} aria-label={`Revoke ${c.contactName}`}>Revoke</button>
                )}
              </div>
            ))}
          </div>

          {otherGrants.length > 0 && (
            <div className="card">
              <header><h3>Past requests</h3><span>{otherGrants.length}</span></header>
              {otherGrants.map(g => (
                <div key={g.id} className="row" style={{ padding: "12px 18px" }}>
                  <div className="g"><span>{new Date(g.triggeredAt).toLocaleDateString()}</span></div>
                  <span className="pill">{GRANT_STATUS_LABEL[g.status]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {addOpen && (
        <AddContactDialog
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); refresh(); }}
        />
      )}
    </VaultSectionPage>
  );
}

function AddContactDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [waitDays, setWaitDays] = useState("30");
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    if (!name.trim()) { toast({ title: "Enter a contact name", variant: "destructive" }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast({ title: "Enter a valid email", variant: "destructive" }); return; }
    const days = Number(waitDays);
    if (!Number.isFinite(days) || days < 3 || days > 365) { toast({ title: "Wait days must be between 3 and 365", variant: "destructive" }); return; }

    setBusy(true);
    try {
      await addEmergencyContact(name.trim(), email.trim(), days);
      toast({ title: "Invite sent", description: `${email.trim()} needs to confirm before this nomination is active.` });
      onSaved();
    } catch (err: any) {
      toast({ title: "Couldn't add contact", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="font-mono">
        <DialogHeader>
          <DialogTitle>Add Trusted Contact</DialogTitle>
          <DialogDescription>They'll get an email to confirm before this nomination is active.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground/60">Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="text-sm" placeholder="Jane Doe" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground/60">Email</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} className="text-sm" placeholder="jane@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground/60">Wait days (inactivity before eligible)</Label>
            <Input type="number" min={3} max={365} value={waitDays} onChange={e => setWaitDays(e.target.value)} className="text-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="font-mono text-xs" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="font-mono text-xs gap-1.5" disabled={busy} onClick={handleSave}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Send Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
