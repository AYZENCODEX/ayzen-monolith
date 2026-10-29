import fs from "node:fs";
import path from "node:path";

const validators = fs.readdirSync("scripts").filter((file) => /^validate-.+\.mjs$/.test(file)).map((file) => `scripts/${file}`);
const sourceFiles = [];
for (const root of [".github", "scripts", "package.json"]) {
  if (!fs.existsSync(root)) continue;
  const visit = (file) => {
    if (fs.statSync(file).isDirectory()) for (const child of fs.readdirSync(file)) visit(path.join(file, child));
    else if (!file.includes("node_modules") && /\.(mjs|json|yml|yaml)$/.test(file)) sourceFiles.push(fs.readFileSync(file, "utf8"));
  };
  visit(root);
}
const orphaned = validators.filter((validator) => !sourceFiles.some((source) => source.includes(validator)));
// full-system-audit discovers every validate-*.mjs file dynamically; it is a
// deliberate caller even though individual filenames are not hard-coded there.
if (fs.existsSync("scripts/full-system-audit.mjs") && orphaned.length) {
  const auditSource = fs.readFileSync("scripts/full-system-audit.mjs", "utf8");
  if (auditSource.includes('fs.readdirSync("scripts")') && auditSource.includes("validate-.+")) orphaned.length = 0;
}
if (orphaned.length) {
  console.error(`Orphaned validators:\n${orphaned.join("\n")}`);
  process.exit(1);
}
console.log(`Validator coverage passed (${validators.length} validators have callers)`);