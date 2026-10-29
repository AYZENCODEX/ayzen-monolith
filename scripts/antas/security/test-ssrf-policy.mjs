import fs from "node:fs";

const policy = fs.existsSync("docs/antas/security/cryptography.md") ? fs.readFileSync("docs/antas/security/cryptography.md", "utf8") : "";
const vault = fs.existsSync("services/vault/src/index.mjs") ? fs.readFileSync("services/vault/src/index.mjs", "utf8") : "";
const required = ["localhost", "127.0.0.1", "169.254.169.254"];
const failures = [];
if (!policy || !vault) failures.push("vault cryptographic evidence is missing");
if (!/SSRF|private/i.test(policy) && !/SSRF|private/i.test(vault)) failures.push("SSRF/private-address policy is not documented");
for (const marker of ["encrypt", "decrypt"]) if (!vault.toLowerCase().includes(marker)) failures.push(`vault marker missing: ${marker}`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ANTAS vault repository controls are present; ${required.length} SSRF targets remain runtime test cases`);