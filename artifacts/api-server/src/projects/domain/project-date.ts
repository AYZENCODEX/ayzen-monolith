/**
 * projects/domain/project-date.ts
 * Pure rules for airdrop-calendar dates: input validation, update building and the
 * public response shape. No database, HTTP, or logging dependencies. Moved unchanged
 * from routes/project-dates.ts (PRJ-02).
 */

export const DEFAULT_EVENT_TYPE = "snapshot";

export interface ProjectDateRecord {
  id: number;
  projectId: number;
  label: string;
  eventType: string;
  eventDate: Date;
  notes: string | null;
  remindedAt: Date | null;
  createdAt: Date;
  projectName?: string | null;
  thumbnailUrl?: string | null;
}

export interface ProjectDateInput {
  label?: string;
  eventType?: string;
  eventDate?: string;
  notes?: string;
}

export interface ProjectDateUpdates {
  label?: string;
  eventType?: string;
  notes?: string;
  eventDate?: Date;
  remindedAt?: null;
}

export function formatProjectDate(d: ProjectDateRecord) {
  return {
    id: d.id,
    projectId: d.projectId,
    projectName: d.projectName ?? null,
    thumbnailUrl: d.thumbnailUrl ?? null,
    label: d.label,
    eventType: d.eventType,
    eventDate: d.eventDate.toISOString(),
    notes: d.notes,
    remindedAt: d.remindedAt ? d.remindedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  };
}

/** Returns the 400 error message, or null when the input is valid. Label is checked first. */
export function validateNewProjectDate(input: ProjectDateInput): string | null {
  const { label, eventDate } = input;
  if (!label || !String(label).trim()) return "label is required";
  if (!eventDate || Number.isNaN(new Date(eventDate).getTime())) return "A valid eventDate is required";
  return null;
}

export function normalizeNewProjectDate(input: ProjectDateInput) {
  return {
    label: String(input.label).trim(),
    eventType: input.eventType || DEFAULT_EVENT_TYPE,
    eventDate: new Date(input.eventDate as string),
    notes: input.notes || null,
  };
}

/** Builds the partial update. Changing the date clears `remindedAt` so the reminder can fire again. */
export function buildProjectDateUpdates(input: ProjectDateInput): { error: string } | { updates: ProjectDateUpdates } {
  const { label, eventType, eventDate, notes } = input;
  const updates: ProjectDateUpdates = {};
  if (label !== undefined) updates.label = String(label).trim();
  if (eventType !== undefined) updates.eventType = eventType;
  if (notes !== undefined) updates.notes = notes;
  if (eventDate !== undefined) {
    if (Number.isNaN(new Date(eventDate).getTime())) return { error: "Invalid eventDate" };
    updates.eventDate = new Date(eventDate);
    updates.remindedAt = null;
  }
  return { updates };
}
