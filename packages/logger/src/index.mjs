const REDACTED = "[REDACTED]";
const SENSITIVE = /token|secret|password|private.?key|authorization|cookie|plaintext|credential/i;

function sanitize(value, depth = 0) {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE.test(key) ? REDACTED : sanitize(child, depth + 1)]));
}

export function createLogger({ service, sink = console } = {}) {
  const write = (level, data, message) => {
    const record = sanitize({ timestamp: new Date().toISOString(), level, service, ...data, ...(message ? { message } : {}) });
    const line = JSON.stringify(record);
    (sink[level] ?? sink.log).call(sink, line);
    return record;
  };
  return Object.freeze({
    debug: (data, message) => write("debug", data, message),
    info: (data, message) => write("info", data, message),
    warn: (data, message) => write("warn", data, message),
    error: (data, message) => write("error", data, message),
    child: (fields) => createLogger({ service, sink: { ...sink, ...fields } }),
  });
}

export { sanitize };