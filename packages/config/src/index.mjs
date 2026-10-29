const BOOLEAN_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE = new Set(["0", "false", "no", "off"]);

export function envString(name, { defaultValue, required = false, pattern } = {}) {
  const value = process.env[name] ?? defaultValue;
  if (required && (typeof value !== "string" || value.length === 0)) throw new Error(`Missing required configuration: ${name}`);
  if (value !== undefined && pattern && !pattern.test(value)) throw new Error(`Invalid configuration: ${name}`);
  return value;
}

export function envNumber(name, { defaultValue, min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined ? defaultValue : Number(raw);
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid numeric configuration: ${name}`);
  }
  return value;
}

export function envBoolean(name, { defaultValue = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const normalized = raw.toLowerCase();
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  throw new Error(`Invalid boolean configuration: ${name}`);
}

export function selectDatabaseUrl({ env = process.env, target = env.DATABASE_URL_TARGET ?? "app" } = {}) {
  if (target === "replit-test") return env.DATABASE_URL;
  if (target !== "app") {
    throw new Error('DATABASE_URL_TARGET must be "app" or "replit-test"');
  }
  return env.APP_DATABASE_URL;
}

export function publicConfig(names) {
  return Object.fromEntries(names.filter((name) => !/(secret|token|password|private|key)/i.test(name)).map((name) => [name, process.env[name]]).filter(([, value]) => value !== undefined));
}