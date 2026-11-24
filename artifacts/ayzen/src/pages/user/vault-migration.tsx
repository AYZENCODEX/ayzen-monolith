/**
 * vault-migration.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 13 — Import/Export Migration Tool.
 *
 * Export: caller's own active Vault entries as CSV or JSON (portable,
 * NOT encrypted — see vault-snapshot.tsx for the encrypted full backup).
 * Import: AYZEN's own CSV/JSON format, or a raw CSV export from 1Password,
 * Bitwarden, or LastPass. Row-level failures are reported individually.
 */
import { useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FileJson, FileSpreadsheet, Loader2, Upload, CheckCircle2, AlertTriangle } from "lucide-react";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  exportVault, importVault, fileToText,
  type ImportFormat, type ImportResult,
} from "@/lib/vault-migration-api";

const IMPORT_SOURCES: { id: ImportFormat; label: string; hint: string }[] = [
  { id: "ayzen_csv", label: "AYZEN CSV", hint: "Re-import a CSV you exported from AYZEN" },
  { id: "ayzen_json", label: "AYZEN JSON", hint: "Re-import a JSON export from AYZEN" },
  { id: "1password", label: "1Password", hint: "1Password's \"Export as CSV\" logins file" },
  { id: "bitwarden", label: "Bitwarden", hint: "Bitwarden's \"Export vault\" CSV file" },
  { id: "lastpass", label: "LastPass", hint: "LastPass's \"Export\" CSV file" },
];

export default function VaultMigration() {
  const { toast } = useToast();
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const [source, setSource] = useState<ImportFormat>("ayzen_csv");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleExport(format: "csv" | "json") {
    setExporting(format);
    try {
      await exportVault(format);
      toast({ title: `Export ready`, description: `Your Vault entries were downloaded as ${format.toUpperCase()}.` });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  async function handleFilePicked(file: File) {
    setImporting(true);
    setResult(null);
    try {
      const text = await fileToText(file);
      const res = await importVault(source, text);
      setResult(res);
      if (res.imported > 0) {
        toast({ title: `Imported ${res.imported} ${res.imported === 1 ? "entry" : "entries"}`, description: res.skipped ? `${res.skipped} row(s) skipped — see details below.` : undefined });
      } else {
        toast({ title: "Nothing was imported", description: "Check the file format matches the source you selected.", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Import failed", description: err?.message, variant: "destructive" });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <VaultSectionPage
      title="Import / Export"
      description="Move Vault entries in from another tool, or out to a CSV/JSON file"
      icon={ArrowDownToLine}
    >
      <div className="stack">
        <div className="card">
          <header><h3>Export vault</h3><span>CSV · JSON</span></header>
          <div className="body">
            <p style={{ margin: "0 0 14px", color: "var(--mu)", fontFamily: "var(--sans)" }}>
              Download your active Vault entries in a portable, unencrypted format —
              for a fully encrypted full-vault backup, use Snapshot Backup instead.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn" disabled={exporting !== null} onClick={() => handleExport("csv")}>
                {exporting === "csv" ? "Preparing…" : "Export as CSV"}
              </button>
              <button type="button" className="btn" disabled={exporting !== null} onClick={() => handleExport("json")}>
                {exporting === "json" ? "Preparing…" : "Export as JSON"}
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <header><h3>Import into vault</h3><span>additive</span></header>
          <div className="body">
            <p style={{ margin: "0 0 14px", color: "var(--mu)", fontFamily: "var(--sans)" }}>
              Imports are additive — new entries are created, nothing existing is overwritten.
            </p>
            <div className="fld">
              <label>Source</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {IMPORT_SOURCES.map(s => (
                  <button key={s.id} type="button" className={`btn sm${source === s.id ? " p" : ""}`} aria-pressed={source === s.id} onClick={() => setSource(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="hint">{IMPORT_SOURCES.find(s => s.id === source)?.hint}</div>
            </div>

            {result && (
              <div className={result.skipped > 0 || result.errors.length > 0 ? "note" : "card"} role="status" style={{ marginBottom: 14, padding: result.skipped > 0 ? undefined : "12px 14px" }}>
                <b>{result.imported} imported</b>
                {result.skipped > 0 && <span>{result.skipped} skipped</span>}
                {result.errors.length > 0 && (
                  <div style={{ maxHeight: 160, overflowY: "auto", marginTop: 8 }}>
                    {result.errors.map((e, i) => (
                      <div key={i} className="mono" style={{ fontSize: 11, color: "var(--mu)" }}>Row {e.row ?? e.index}: {e.reason}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFilePicked(f); }}
            />
            <button type="button" className="btn p" disabled={importing} onClick={() => fileInputRef.current?.click()}>
              {importing ? "Importing…" : "Choose file & import"}
            </button>
          </div>
        </div>
      </div>
    </VaultSectionPage>
  );
}
