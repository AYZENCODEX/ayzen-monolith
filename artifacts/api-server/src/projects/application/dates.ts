/**
 * projects/application/dates.ts
 * Use cases for the airdrop calendar (PRJ-02). Moved unchanged from routes/project-dates.ts:
 * the route file is now a thin adapter that parses HTTP input and maps results to responses.
 * Database errors propagate to the adapter, which keeps each handler's original error behavior.
 */
import { logBus } from "../../lib/log-bus";
import {
  buildProjectDateUpdates,
  formatProjectDate,
  normalizeNewProjectDate,
  validateNewProjectDate,
  type ProjectDateInput,
} from "../domain/project-date";
import {
  deleteDate,
  insertDate,
  listCalendarRows,
  listDatesForProject,
  listEnrolledProjectIds,
  updateDate,
} from "../infrastructure/repositories/dates-repo";

/** Every date across every project; `mine` limits to enrolled projects, `upcomingOnly` drops dates over a day old. */
export async function listCalendar(userId: number, opts: { mine: boolean; upcomingOnly: boolean }) {
  let projectIdFilter: number[] | null = null;
  if (opts.mine) {
    projectIdFilter = await listEnrolledProjectIds(userId);
    if (projectIdFilter.length === 0) return [];
  }
  const rows = await listCalendarRows({ projectIdFilter, upcomingOnly: opts.upcomingOnly });
  rows.sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());
  return rows.map((r) => formatProjectDate(r));
}

/** Dates for one project. Intentionally no enrollment check (C29 owner sign-off, unchanged). */
export async function listProjectDates(projectId: number) {
  const rows = await listDatesForProject(projectId);
  rows.sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());
  return rows.map((r) => formatProjectDate(r));
}

export type CreateDateResult = { ok: true; date: ReturnType<typeof formatProjectDate> } | { ok: false; error: string };

export async function createProjectDate(projectId: number, input: ProjectDateInput): Promise<CreateDateResult> {
  const error = validateNewProjectDate(input);
  if (error) return { ok: false, error };
  const row = await insertDate({ projectId, ...normalizeNewProjectDate(input) });
  logBus.system(`Airdrop calendar: added "${row.label}" for project #${projectId} (${row.eventDate.toISOString()})`);
  return { ok: true, date: formatProjectDate(row) };
}

export type UpdateDateResult =
  | { ok: true; date: ReturnType<typeof formatProjectDate> }
  | { ok: false; status: 400 | 404; error: string };

export async function updateProjectDate(id: number, input: ProjectDateInput): Promise<UpdateDateResult> {
  const built = buildProjectDateUpdates(input);
  if ("error" in built) return { ok: false, status: 400, error: built.error };
  const row = await updateDate(id, built.updates);
  if (!row) return { ok: false, status: 404, error: "Date not found" };
  return { ok: true, date: formatProjectDate(row) };
}

/** True when a row was deleted, false when it did not exist. */
export async function deleteProjectDate(id: number): Promise<boolean> {
  return Boolean(await deleteDate(id));
}
