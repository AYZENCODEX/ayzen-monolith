// Source-derived census of direct infrastructure access (DB / provider / event / job / storage) in Vault behavior code.
// Used by validate-gap.mjs --stage census when a gap config declares `infraCensus`; the result is sealed with the census.
import fs from "node:fs";
import path from "node:path";
import { ROOT, sha256 } from "./gap-common.mjs";

const CATEGORIES = {
  db: /\b(db|dbHandle|tx|trx|conn)\s*\n?\s*\.\s*(select|insert|update|delete|execute|transaction)\b|\((tx|trx|db)\s+as\s+any\)\s*\.\s*(select|insert|update|delete|execute)|sql`|sql\.raw|\.execute\(|from\(\w+Table\)/,
  provider: /\bfetch\(|sendEmail|sendToUser|sendVault\w*Email|send\w*Email\(|createNotification|nodemailer|S3Client|googleapis|axios/,
  event: /publishAyzenDomainEvent|emitEvent|eventBus|logBus\.|EventEmitter/,
  job: /cron\.schedule|setInterval\(|setTimeout\(/,
  storage: /\bfs\.|fs\/promises|writeFile|readFile|putObject|getObject|Buffer\.from\([^)]*base64/,
};

export function scanInfraAccess(ts, files) {
  const records = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    const tree = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    for (const n of tree.statements) {
      let name = null;
      if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
      else if (ts.isVariableStatement(n)) { const d = n.declarationList.declarations[0]; if (d && ts.isIdentifier(d.name)) name = d.name.text; }
      if (!name) continue;
      const t = n.getText(tree);
      const categories = Object.entries(CATEGORIES).filter(([, re]) => re.test(t)).map(([k]) => k);
      if (!categories.length) continue;
      records.push({ file: f, name, lines: t.split("\n").length, categories, exported: !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword), body_sha256: sha256(t) });
    }
  }
  return records;
}

// classify(record) -> { disposition, target? } ; dispositions are declared in the gap config, never guessed here.
export function buildInfraCensus(ts, spec) {
  const records = scanInfraAccess(ts, spec.files()).map((r) => ({ ...r, ...spec.classify(r) }));
  const summary = {};
  for (const r of records) summary[r.disposition] = (summary[r.disposition] ?? 0) + 1;
  return { records, summary: { symbols: records.length, files: new Set(records.map((r) => r.file)).size, by_disposition: summary, by_category: Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, records.filter((r) => r.categories.includes(c)).length])) } };
}
