// projects/infrastructure/repositories/entity-overview-repo.ts
// Raw-SQL reads behind the per-entity overview and the entity leaderboard (PRJ-05). SQL text is moved
// unchanged from routes/projects.ts. userId and vaultEntryId are numbers parsed by the adapter or taken from the
// authenticated session; they are interpolated exactly as before.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function queryEntityProjectRows(userId: number, vaultEntryId: number): Promise<any[]> {
  const rows = await db.execute(sql.raw(
    `SELECT
         p.id as project_id, p.name as project_name, p.project_type, p.category,
         p.thumbnail_url,
         (SELECT COUNT(*) FROM tasks WHERE project_id = p.id)::int as total_tasks,
         (SELECT COUNT(*) FROM task_submissions ts2
            JOIN tasks t2 ON t2.id = ts2.task_id
            WHERE t2.project_id = p.id AND ts2.user_id = ${userId} AND ts2.status IN ('approved','completed'))::int as completed_tasks,
         COALESCE((SELECT SUM(ts3.profit) FROM task_submissions ts3
            JOIN tasks t3 ON t3.id = ts3.task_id
            WHERE t3.project_id = p.id AND ts3.user_id = ${userId} AND ts3.status IN ('approved','completed')), 0) as total_profit,
         COALESCE((SELECT SUM(ts4.cost) FROM task_submissions ts4
            JOIN tasks t4 ON t4.id = ts4.task_id
            WHERE t4.project_id = p.id AND ts4.user_id = ${userId} AND ts4.status IN ('approved','completed')), 0) as total_cost,
         pe.id as enrollment_id, pe.enrolled_at, pe.status as enrollment_status
       FROM project_enrollments pe
       JOIN projects p ON p.id = pe.project_id
       WHERE pe.vault_entry_id = ${vaultEntryId} AND pe.user_id = ${userId}
       ORDER BY pe.enrolled_at DESC`
  ));
  return rows.rows as any[];
}

export async function queryEntityRow(userId: number, vaultEntryId: number): Promise<any[]> {
  const entity = await db.execute(sql.raw(
    `SELECT entity_serial, project_name as entity_name, category, twitter_username, discord_username, email
       FROM vault_entries WHERE id = ${vaultEntryId} AND user_id = ${userId}`
  ));
  return entity.rows as any[];
}

/** Activity heatmap data: task completions by day over the past 365 days. */
export async function queryEntityActivityRows(userId: number, vaultEntryId: number): Promise<any[]> {
  const activityRows = await db.execute(sql.raw(
    `SELECT DATE(ts.submitted_at)::text as day, COUNT(*)::int as count
       FROM task_submissions ts
       JOIN tasks t ON t.id = ts.task_id
       JOIN project_enrollments pe ON pe.project_id = t.project_id
       WHERE pe.vault_entry_id = ${vaultEntryId}
         AND ts.user_id = ${userId}
         AND ts.status IN ('approved', 'completed')
         AND ts.submitted_at >= NOW() - INTERVAL '365 days'
       GROUP BY DATE(ts.submitted_at)
       ORDER BY day ASC`
  ));
  return activityRows.rows as any[];
}

export async function queryEntityLeaderboardRows(userId: number): Promise<any[]> {
  const rows = await db.execute(sql.raw(
    `SELECT
         ve.id as vault_entry_id,
         ve.entity_serial,
         ve.project_name as entity_name,
         ve.category,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId}
         ) as total_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'completed'
         ) as completed_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status != 'completed'
         ) as ongoing_projects,
         -- Phase 18: per-status breakdown (Phase 5's disqualify/ban/cancel-enrollment
         -- statuses) — powers the vault card/quick-view enrollment summary + status
         -- flags without a separate per-entity request.
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'active'
         ) as active_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'disqualified'
         ) as disqualified_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'banned'
         ) as banned_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'cancelled'
         ) as cancelled_projects,
         COALESCE((
           SELECT COUNT(*)::int FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ${userId} AND ts.status IN ('approved','completed')
         ), 0) as total_completions,
         COALESCE((
           SELECT SUM(ts.profit) FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ${userId} AND ts.status IN ('approved','completed')
         ), 0)::float as total_profit,
         COALESCE((
           SELECT SUM(ts.cost) FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ${userId} AND ts.status IN ('approved','completed')
         ), 0)::float as total_cost
       FROM vault_entries ve
       WHERE ve.user_id = ${userId}`
  ));
  return rows.rows as any[];
}
