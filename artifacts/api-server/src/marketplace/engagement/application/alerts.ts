/**
 * marketplace/engagement/application/alerts.ts
 * MKT-05c: use cases behind the alert and saved-search routes. The route adapter keeps destructuring req.body BEFORE its
 * try block (so a request without a JSON body fails the way it did before) and passes the fields in. Validation failures are
 * results (400); a missing row is a result (404); database errors are thrown and answered 500 by the adapter.
 */
import { buildAlertUpdate, createAlertParams, savedSearchParams, validateCreateAlert, validateSavedSearch, type CreateAlertInput, type SavedSearchInput, type UpdateAlertFields } from "../domain/alerts";
import type { AlertsRepo } from "../infrastructure/alerts-repo";

export type Bad = { ok: false; status: 400 | 404; error: string };
export type Row = { ok: true; row: any };

export function createAlertsService(repo: AlertsRepo) {
  return {
    async create(userId: number, input: CreateAlertInput): Promise<Row | Bad> {
      const error = validateCreateAlert(input);
      if (error) return { ok: false, status: 400, error };
      return { ok: true, row: (await repo.insertAlert(createAlertParams(userId, input)))[0] };
    },
    list: (userId: number): Promise<any[]> => repo.listAlerts(userId),
    async update(userId: number, id: number, fields: UpdateAlertFields): Promise<Row | Bad> {
      const built = buildAlertUpdate(fields, id, userId);
      if (!built) return { ok: false, status: 400, error: "No fields to update" };
      const rows = await repo.runAlertUpdate(built.sql, built.params);
      return rows.length === 0 ? { ok: false, status: 404, error: "Alert not found or not yours" } : { ok: true, row: rows[0] };
    },
    async remove(userId: number, id: number): Promise<{ ok: true } | Bad> {
      const rows = await repo.deleteAlert(id, userId);
      return rows.length === 0 ? { ok: false, status: 404, error: "Alert not found or not yours" } : { ok: true };
    },
    async createSavedSearch(userId: number, input: SavedSearchInput): Promise<Row | Bad> {
      const error = validateSavedSearch(input);
      if (error) return { ok: false, status: 400, error };
      return { ok: true, row: (await repo.insertSavedSearch(savedSearchParams(userId, input)))[0] };
    },
    listSavedSearches: (userId: number): Promise<any[]> => repo.listSavedSearches(userId),
  };
}
