import fs from "node:fs";

const failures = [];
const files = [
  "packages/auth-client/src/index.mjs",
  "packages/identity/src/index.mjs",
  "docs/security/session-policy.md",
];
for (const file of files) if (!fs.existsSync(file)) failures.push(`missing identity evidence: ${file}`);
const auth = fs.existsSync(files[0]) ? fs.readFileSync(files[0], "utf8") : "";
for (const marker of ["createStepUpToken", "verifyStepUpToken", "createJwksAuthenticator", "issuer", "audience"]) {
  if (!auth.toLowerCase().includes(marker.toLowerCase())) failures.push(`identity control marker missing: ${marker}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("ANTAS identity repository controls are present; provider-backed drills remain unverified");