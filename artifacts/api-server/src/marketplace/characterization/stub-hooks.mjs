import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../..");
const STUBS = new Map([
  ["middlewares/auth.ts", "auth.stub.ts"], // real one authenticates with JWT + users table + authorization_audit_log
  ["lib/policy/pep/middleware.ts", "pep-middleware.stub.ts"], // authorization is NOT characterized by this suite
  ["lib/notification-bus.ts", "notification-bus.stub.ts"], // records calls instead of writing notifications / Telegram / email
  ["services/credit-meter.ts", "credit-meter.stub.ts"], // only the boost route uses it; not a money path of this suite
].map(([target, stub]) => [path.join(src, target), path.join(here, "stubs", stub)]));

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!resolved.url.startsWith("file:")) return resolved;
  const u = new URL(resolved.url);
  const file = fileURLToPath(`file://${u.pathname}`);
  const stub = STUBS.get(file);
  if (!stub) return resolved;
  return { ...resolved, url: pathToFileURL(stub).href + u.search + u.hash, shortCircuit: true };
}
