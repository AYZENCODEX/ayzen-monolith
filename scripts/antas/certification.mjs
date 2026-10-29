import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("config/antas/roadmap-0-18.json", "utf8"));
const phaseReports = manifest.phases.map((phase) => {
  const reportPath = `reports/antas/ANTAS-${String(phase.phase).padStart(2, "0")}/report.json`;
  if (!fs.existsSync(reportPath)) return { phase: phase.phase, status: "UNVERIFIED", report: reportPath };
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  return { phase: phase.phase, status: report.status, criticalFailures: report.criticalFailures, report: reportPath };
});
const p0Unresolved = phaseReports.filter((phase) => [0, 1, 3, 4, 5, 6, 7, 8, 13].includes(phase.phase) && phase.status !== "PASS");
const certification = {
  schemaVersion: 1,
  phaseRange: [0, 18],
  generatedAt: new Date().toISOString(),
  status: p0Unresolved.length ? "UNVERIFIED" : "UNVERIFIED",
  productionReady: false,
  p0Unresolved,
  externalGates: manifest.phases.flatMap((phase) => phase.externalGates.map((gate) => ({ phase: phase.phase, gate, status: "UNVERIFIED" }))),
  phases: phaseReports,
  rule: "Production certification is blocked until runtime evidence and release-owner sign-off are recorded.",
};
fs.mkdirSync("reports/antas/ANTAS-18", { recursive: true });
fs.writeFileSync("reports/antas/ANTAS-18/certification.json", `${JSON.stringify(certification, null, 2)}\n`);
console.log(JSON.stringify({ output: "reports/antas/ANTAS-18/certification.json", status: certification.status, productionReady: false }, null, 2));