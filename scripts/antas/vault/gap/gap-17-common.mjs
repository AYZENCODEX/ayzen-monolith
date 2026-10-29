// VLT-GAP-17 shared helpers: map parser, repo index, import graph, evidence state.
// Used by validate-vlt-gap-17.mjs (the gate) and generate-vlt-gap-17-map.mjs (the per-file census writer).
import fs from "node:fs";
import path from "node:path";

export const SRC = "artifacts/api-server/src";
export const MAP_DOC = "docs/antas/vault/file-migration-map.md";
export const GEN_BEGIN = "<!-- VLT-GAP-17:GENERATED-BEGIN (per-file census; regenerate with generate-vlt-gap-17-map.mjs) -->";
export const GEN_END = "<!-- VLT-GAP-17:GENERATED-END -->";
export const EVIDENCE_DIR = "reports/antas/vault/gap";
const CODE_EXT = /\.(ts|tsx|mts|mjs|cjs|js)$/;
const TEXT_EXT = /\.(ts|tsx|mts|mjs|cjs|js|yml|yaml|sh)$|(^|\/)package\.json$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "reports", "docs", "attached_assets", ".turbo", "coverage", "build", ".next"]);

// ── map parsing ────────────────────────────────────────────────────────────────────────────────────────────
export function braceExpand(p) {
  const m = p.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  return m ? m[2].split(",").flatMap((x) => braceExpand(m[1] + x + m[3])) : [p];
}
export function pathTokens(cell) {
  const ticks = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const raw = ticks.length ? ticks.flatMap((t) => t.split(/\s*,\s*(?![^{]*\})/)) : cell.split(/\s+/);
  return raw.map((t) => t.replace(/[,;.]+$/, "").trim()).filter((t) => t.includes("/") && (/\.(ts|tsx|mts|mjs)$/.test(t) || /\*$/.test(t))).flatMap(braceExpand);
}
export function classify(statusRaw) {
  const s = statusRaw.trim();
  const kind = /^RETIRED\b/.test(s) ? "RETIRED" : /^EXTRACTED\b/.test(s) ? "EXTRACTED" : /^IMPLEMENTED\b/.test(s) ? "IMPLEMENTED"
    : /^NEW-SEAM\b/.test(s) ? "NEW-SEAM" : /^compatibility-preserved\b/.test(s) ? "COMPAT" : /^thin entrypoint/.test(s) ? "THIN"
    : /^extracted\b/.test(s) ? "SEAM" : "UNKNOWN";
  return { kind, gaps: [...new Set([...s.matchAll(/VLT-GAP-(\d\d)/g)].map((m) => m[1]))], uncertified: /UNCERTIFIED/.test(s), pending: /pending/i.test(s), shim: /re-export-only shim/i.test(s) };
}
export function parseMap(text) {
  const rows = [];
  text.split("\n").forEach((line, i) => {
    if (!line.startsWith("|")) return;
    const c = line.split("|").slice(1, -1).map((s) => s.trim());
    if (c.length < 4 || /^-+$/.test(c[0]) || c[0] === "Classification") return;
    rows.push({ line: i + 1, cls: c[0], oldRaw: c[1], newRaw: c[2], statusRaw: c[3], old: pathTokens(c[1]), new: pathTokens(c[2]), ...classify(c[3]) });
  });
  return rows;
}
export const globToRe = (g) => new RegExp(`^${g.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);

// ── repo index ─────────────────────────────────────────────────────────────────────────────────────────────
export function indexRepo(root) {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || e.name.endsWith(".tsbuildinfo")) continue;
      const p = path.join(dir, e.name);
      const r = path.relative(root, p).split(path.sep).join("/");
      if (r === "scripts/antas") continue; // validators legitimately name old paths
      if (e.isDirectory()) walk(p); else files.push(r);
    }
  };
  walk(root);
  const set = new Set(files);
  return { files, set, has: (f) => set.has(f), match: (glob) => { const re = globToRe(glob); return files.filter((f) => re.test(f)); } };
}
export const stripExt = (f) => f.replace(/\.(ts|tsx|mts|mjs|cjs|js)$/, "");

// Edges (resolved repo-relative file) for every relative string literal in every code file; plus raw text for path-string refs.
export function buildGraph(root, idx) {
  const edges = new Map(), texts = new Map(), dangling = new Map(); // dangling: relative specifiers that resolve to no file (an import of a retired path)
  const resolve = (from, spec) => {
    const b = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const bare = b.replace(/\.(js|mjs|cjs|ts|tsx|mts)$/, "");
    for (const c of [b, `${bare}.ts`, `${bare}.tsx`, `${bare}.mts`, `${bare}.mjs`, `${bare}.js`, `${b}/index.ts`, `${b}/index.mjs`, `${b}/index.js`]) if (idx.has(c)) return c;
    return null;
  };
  for (const f of idx.files) {
    if (!TEXT_EXT.test(f) || f.endsWith(".d.ts")) continue;
    const t = fs.readFileSync(path.join(root, f), "utf8");
    texts.set(f, t);
    if (!CODE_EXT.test(f)) continue;
    const out = new Set(), dang = new Set();
    for (const m of t.matchAll(/["'`](\.{1,2}\/[^"'`\s]*)["'`]/g)) {
      const r = resolve(f, m[1]);
      if (r) out.add(r); else dang.add(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])).replace(/\.(js|mjs|cjs|ts|tsx|mts)$/, ""));
    }
    edges.set(f, [...out]);
    dangling.set(f, dang);
  }
  const reach = (start) => { const seen = new Set([start]), st = [start]; while (st.length) { const x = st.pop(); for (const y of edges.get(x) ?? []) if (!seen.has(y)) { seen.add(y); st.push(y); } } return seen; };
  // every file that imports `target` (by resolved edge) or names its repo-relative path (with or without extension)
  const importersOf = (target) => {
    const hits = new Set();
    const bare = stripExt(target);
    for (const [f, es] of edges) if (f !== target && es.some((e) => e === target || stripExt(e) === bare)) hits.add(f);
    for (const [f, d] of dangling) if (f !== target && d.has(bare)) hits.add(f);
    for (const [f, t] of texts) if (f !== target && (t.includes(target) || t.includes(bare))) hits.add(f);
    return [...hits].sort();
  };
  const reverse = new Map();
  for (const [f, es] of edges) for (const e of es) (reverse.get(e) ?? reverse.set(e, new Set()).get(e)).add(f);
  return { edges, texts, reach, importersOf, reverse };
}

// ── evidence ───────────────────────────────────────────────────────────────────────────────────────────────
// Recorded per-GAP evidence. RETIRED claims need a retire/gate PASS; EXTRACTED claims need any PASS (extraction/retire/gate).
export function evidenceState(root, gap, scopedFiles = []) {
  const dir = path.join(root, EVIDENCE_DIR, `VLT-GAP-${gap}`);
  const read = (n) => { try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); return { file: `${EVIDENCE_DIR}/VLT-GAP-${gap}/${n}`, status: j.status ?? "MISSING-STATUS", sub_phase: j.sub_phase ?? null, binding: j.commit_sha ?? j.source_tree_sha256 ?? null, at: j.generated_at ?? j.checked_at ?? null }; } catch { return null; } };
  const gate = read("gate.json"), retire = read("retire-proof.json"), extract = read("extraction-proof.json");
  const pass = (e) => !!e && e.status === "PASS";
  let currentProof = null;
  if (gap === "04") {
    const routePath = "reports/antas/vault/gap/VLT-GAP-13/route-thinness.json";
    const equivalencePath = "reports/antas/vault/gap/VLT-GAP-15/gate.json";
    const comparePath = "reports/antas/vault/gap/VLT-GAP-15/compare.json";
    const load = (p) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), "utf8")); } catch { return null; } };
    const routeReport = load(routePath), equivalenceReport = load(equivalencePath), compareReport = load(comparePath);
    const sourcePaths = [...new Set(scopedFiles)].filter((p) => !p.includes("*")).map((p) => path.join(root, p)).filter((p) => fs.existsSync(p));
    const sourceMtime = sourcePaths.length ? Math.max(...sourcePaths.map((p) => fs.statSync(p).mtimeMs)) : Infinity;
    const fresh = (p) => { try { return fs.statSync(path.join(root, p)).mtimeMs >= sourceMtime; } catch { return false; } };
    const routeFiles = (routeReport?.route_files ?? []).map((r) => typeof r === "string" ? r : r.file ?? r.path ?? "");
    const routeCoverage = routeFiles.some((p) => p.endsWith("/routes/game-entries.ts")) &&
      routeFiles.some((p) => p.endsWith("/routes/marketplace-game.ts"));
    const coveredResiduals = (compareReport?.open_for_15_D ?? []).every((item) => item.covered_by_passing_differential === true);
    const routePass = routeReport?.status === "PASS" && routeCoverage && (routeReport.violations ?? []).length === 0 && fresh(routePath);
    const equivalencePass = equivalenceReport?.status === "PASS" &&
      equivalenceReport.equal_cells > 0 && equivalenceReport.equal_cells === compareReport?.equal_cells &&
      (equivalenceReport.errors ?? []).length === 0 &&
      compareReport?.status === "PASS" && compareReport.equal_cells === compareReport.total_cells &&
      (compareReport.errors ?? []).length === 0 && coveredResiduals && fresh(equivalencePath) && fresh(comparePath);
    currentProof = {
      status: routePass && equivalencePass ? "PASS" : "NOT-CURRENTLY-PROVEN",
      sources_checked: sourcePaths.length,
      source_mtime_latest: Number.isFinite(sourceMtime) ? new Date(sourceMtime).toISOString() : null,
      route_thinness: { file: routePath, status: routeReport?.status ?? "MISSING", covers_game_routes: routeCoverage, fresh: fresh(routePath) },
      equivalence: { gate: equivalencePath, compare: comparePath, status: equivalenceReport?.status ?? "MISSING", equal_cells: equivalenceReport?.equal_cells ?? null, total_cells: equivalenceReport?.total_cells ?? null, residuals_covered: coveredResiduals, fresh: fresh(equivalencePath) && fresh(comparePath) },
    };
  }
  const extractedOk = gap === "04" ? currentProof?.status === "PASS" : pass(gate) || pass(retire) || pass(extract);
  const gateFailed = gap === "04" ? currentProof?.status !== "PASS" : !!gate && gate.status !== "PASS";
  return {
    gap, gate, retire, extract, current_proof: currentProof,
    retired_ok: pass(gate) || (pass(retire) && !gate) || (pass(retire) && gate === null),
    extracted_ok: extractedOk,
    gate_failed: gateFailed,
  };
}
export const certifiedFor = (ev, kind) => (kind === "RETIRED" ? ev.retired_ok && !ev.gate_failed : ev.extracted_ok && !ev.gate_failed && !(ev.extract && ev.extract.status !== "PASS" && !ev.gate));
