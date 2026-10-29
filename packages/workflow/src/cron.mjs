/**
 * H13 — Season 2 audit finding §4: "Scheduler — does not exist anywhere in
 * the new services architecture." This is the one missing primitive
 * `services/workflow/src/schedules.mjs` needs and nothing in this repo
 * (new architecture) already provided: standard 5-field cron parsing and
 * "what's the next occurrence after this instant" arithmetic. (The
 * legacy monolith's `artifacts/api-server/src/lib/scheduler/cron-parser.*`
 * is a separate, unrelated implementation — see the audit's own note that
 * the legacy scheduler "has no relationship to the extracted-services
 * architecture at all"; this is a fresh, small implementation for the new
 * architecture rather than reaching into the monolith.)
 *
 * Standard 5-field syntax: `minute hour day-of-month month day-of-week`.
 * Each field accepts `*`, a step wildcard (star-slash-N), a single value, a list (`a,b,c`), a
 * range (`a-b`), or a stepped range (`a-b/step`). day-of-month and
 * day-of-week combine with OR when both are restricted (non-`*`) — the
 * same convention cron(5) itself uses — so `0 0 1 * MON` fires on both
 * the 1st of the month AND every Monday, not their intersection.
 *
 * All arithmetic is UTC. A schedule's `nextRunAt` is always strictly
 * after the `from` instant passed in — never `from` itself, even when
 * `from` exactly matches the expression — so a schedule is never "due"
 * again for the same instant it just computed from.
 */

const FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function resolveToken(token, field) {
  const lower = token.toLowerCase();
  if (field === "month" && lower in MONTH_NAMES) return MONTH_NAMES[lower];
  if (field === "dayOfWeek" && lower in DOW_NAMES) return DOW_NAMES[lower];
  if (!/^\d+$/.test(token)) throw new Error(`Invalid ${field} value: ${token}`);
  return Number(token);
}

/** Parses one comma-separated cron field into a Set of matching integer values. */
function parseField(raw, field) {
  const [min, max] = FIELD_RANGES[field];
  const values = new Set();
  for (const part of raw.split(",")) {
    if (part === "") throw new Error(`Invalid ${field} field: "${raw}"`);
    const [rangePart, stepPart] = part.split("/");
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1)) {
      throw new Error(`Invalid step in ${field} field: "${part}"`);
    }
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    let start;
    let end;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [fromTok, toTok] = rangePart.split("-");
      if (fromTok === undefined || toTok === undefined) throw new Error(`Invalid range in ${field} field: "${part}"`);
      start = resolveToken(fromTok, field);
      end = resolveToken(toTok, field);
      if (start > end) throw new Error(`Invalid range in ${field} field: "${part}"`);
    } else {
      start = resolveToken(rangePart, field);
      end = start;
    }
    // dayOfWeek: 7 is an accepted alias for Sunday (0) in cron(5), so the
    // upper bound is relaxed to 7 here; parseField normalizes it back to 0
    // below, after every value in this field has been collected.
    const effectiveMax = field === "dayOfWeek" ? 7 : max;
    if (start < min || end > effectiveMax) throw new Error(`Value out of range in ${field} field: "${part}"`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`Empty ${field} field: "${raw}"`);
  // day-of-week: normalize 7 -> 0 (both mean Sunday in cron(5)).
  if (field === "dayOfWeek" && values.has(7)) { values.delete(7); values.add(0); }
  return values;
}

/**
 * Parses a 5-field cron expression. Throws a plain Error (message-only —
 * ./schedules.mjs's computeNextRunAt wraps it with a stable error code)
 * on anything malformed: wrong field count, out-of-range values, bad
 * ranges/steps, or unrecognized tokens.
 */
export function parseCron(expression) {
  if (typeof expression !== "string") throw new Error("Cron expression must be a string");
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have 5 fields, got ${fields.length}: "${expression}"`);
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields;
  return Object.freeze({
    minute: parseField(minuteRaw, "minute"),
    hour: parseField(hourRaw, "hour"),
    dayOfMonth: parseField(domRaw, "dayOfMonth"),
    month: parseField(monthRaw, "month"),
    dayOfWeek: parseField(dowRaw, "dayOfWeek"),
    // Whether day-of-month/day-of-week were left as "*" — needed for the
    // OR-combination rule (a restricted field participates in the OR; a
    // wildcard field doesn't get to veto a match the other field allows).
    domRestricted: domRaw !== "*",
    dowRestricted: dowRaw !== "*",
  });
}

const MAX_MINUTES_TO_SEARCH = 5 * 366 * 24 * 60; // 5 years — generous upper bound for any valid expression, including Feb 29-only-style rarities.

/**
 * Returns the next Date (UTC, minute resolution — cron never fires on
 * sub-minute boundaries) strictly after `from` that matches `cronExpr`.
 * Throws whatever parseCron throws if the expression itself is invalid.
 */
export function nextRunAfter(cronExpr, from = new Date()) {
  const parsed = parseCron(cronExpr);
  const candidate = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
    from.getUTCHours(), from.getUTCMinutes(), 0, 0,
  ));
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1); // strictly after `from`, minute-aligned

  for (let i = 0; i < MAX_MINUTES_TO_SEARCH; i += 1) {
    if (matches(candidate, parsed)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error(`No matching occurrence found for cron expression within the search horizon: "${cronExpr}"`);
}

function matches(date, parsed) {
  if (!parsed.minute.has(date.getUTCMinutes())) return false;
  if (!parsed.hour.has(date.getUTCHours())) return false;
  if (!parsed.month.has(date.getUTCMonth() + 1)) return false;
  const domMatch = parsed.dayOfMonth.has(date.getUTCDate());
  const dowMatch = parsed.dayOfWeek.has(date.getUTCDay());
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch;
  if (parsed.domRestricted) return domMatch;
  if (parsed.dowRestricted) return dowMatch;
  return true;
}
