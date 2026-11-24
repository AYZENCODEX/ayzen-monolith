/**
 * vault-compliance.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 14 — Compliance Audit Report Export.
 *
 * Date-ranged CSV/PDF export of the caller's own activity, merging the
 * account-level (user_activity) and Vault-level (vault_activity_log) audit
 * trails into one timeline. See routes/compliance-report.ts.
 */
import { useState } from "react";
import { FileBarChart, Loader2, FileText, FileSpreadsheet } from "lucide-react";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { downloadComplianceReport, type ReportFormat } from "@/lib/compliance-report-api";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function VaultCompliance() {
  const { toast } = useToast();
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [downloading, setDownloading] = useState<ReportFormat | null>(null);

  async function handleDownload(format: ReportFormat) {
    if (!from || !to) { toast({ title: "Choose a start and end date", variant: "destructive" }); return; }
    if (from > to) { toast({ title: "Start date must be before end date", variant: "destructive" }); return; }
    setDownloading(format);
    try {
      await downloadComplianceReport(from, to, format);
      toast({ title: "Report downloaded" });
    } catch (err: any) {
      toast({ title: "Couldn't generate report", description: err?.message, variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  }

  return (
    <VaultSectionPage
      title="Compliance Report"
      description="Export your account & Vault activity for a date range as CSV or PDF"
      icon={FileBarChart}
    >
      <div className="card">
        <header><h3>Activity report</h3><span>CSV or PDF</span></header>
        <div className="body">
          <p style={{ margin: "0 0 14px", color: "var(--mu)", fontFamily: "var(--sans)" }}>
            Combines your account activity log and Vault entity activity log into one timeline.
          </p>
          <div className="g2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: 440 }}>
            <div className="fld">
              <label htmlFor="rep-from">From</label>
              <span className="in"><input id="rep-from" type="date" value={from} onChange={e => setFrom(e.target.value)} /></span>
            </div>
            <div className="fld">
              <label htmlFor="rep-to">To</label>
              <span className="in"><input id="rep-to" type="date" value={to} onChange={e => setTo(e.target.value)} /></span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
            <button type="button" className="btn" disabled={downloading !== null} onClick={() => handleDownload("csv")}>
              {downloading === "csv" ? "Preparing…" : "Download CSV"}
            </button>
            <button type="button" className="btn p" disabled={downloading !== null} onClick={() => handleDownload("pdf")}>
              {downloading === "pdf" ? "Preparing…" : "Download PDF"}
            </button>
          </div>
        </div>
      </div>
    </VaultSectionPage>
  );
}
