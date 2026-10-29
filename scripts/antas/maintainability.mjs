import fs from "node:fs";
import path from "node:path";

const skip = new Set(["node_modules", "dist", "build", ".git", ".cache"]);
const files = [];
const stack = ["apps", "artifacts", "packages", "services", "scripts"];
while (stack.length) {
  const current = stack.pop();
  if (!fs.existsSync(current)) continue;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) stack.push(target);
    else if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(entry.name)) files.push(target);
  }
}
const rows = files.map((file) => {
  const source = fs.readFileSync(file, "utf8");
  return {
    file,
    lines: source.split("\n").length,
    any: (source.match(/\bany\b/g) ?? []).length,
    todoFixme: (source.match(/\b(?:TODO|FIXME)\b/gi) ?? []).length,
  };
});
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  files: rows.length,
  anyOccurrences: rows.reduce((sum, row) => sum + row.any, 0),
  todoFixmeOccurrences: rows.reduce((sum, row) => sum + row.todoFixme, 0),
  largeFiles: rows.filter((row) => row.lines > 1000).sort((a, b) => b.lines - a.lines).slice(0, 50),
  note: "This report identifies maintainability work; it does not silently waive findings.",
};
fs.mkdirSync("reports/antas/ANTAS-16", { recursive: true });
fs.writeFileSync("reports/antas/ANTAS-16/maintainability.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: "reports/antas/ANTAS-16/maintainability.json", files: report.files, any: report.anyOccurrences, largeFiles: report.largeFiles.length }, null, 2));