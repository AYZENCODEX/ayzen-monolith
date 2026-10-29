import fs from "node:fs";

const schema = JSON.parse(fs.readFileSync("infrastructure/deployment/environment.schema.json", "utf8"));
const environment = process.argv.find((arg) => arg.startsWith("--environment="))?.slice("--environment=".length)
  ?? process.env.NODE_ENV
  ?? "development";
const profile = schema.profiles[environment];
if (!profile) {
  console.error(`Unknown deployment environment: ${environment}`);
  process.exit(1);
}

const failures = [];
for (const name of profile.required ?? []) {
  if (!process.env[name]) failures.push(`Missing required configuration: ${name}`);
}
for (const names of profile.requiredAnyOf ?? []) {
  if (!names.some((name) => process.env[name])) failures.push(`One of these configuration values is required: ${names.join(", ")}`);
}
for (const forbidden of profile.forbidden ?? []) {
  const [name, value] = forbidden.split("=", 2);
  if (process.env[name] === value) failures.push(`Local development value is not allowed in ${environment}: ${name}`);
}
for (const [name, value] of Object.entries(profile.defaults ?? {})) {
  if (process.env[name] === undefined) process.env[name] = value;
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, environment, checked: [...(profile.required ?? []), ...(profile.requiredAnyOf ?? []).flat()] }));