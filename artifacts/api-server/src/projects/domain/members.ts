/**
 * projects/domain/members.ts
 * Pure mapping for project members, stats and per-entity task completion. No database, HTTP, or logging
 * dependencies. Moved unchanged from routes/projects.ts (PRJ-05). Row inputs are raw (snake_case) SQL rows.
 */

export function mapMembers(rows: any[]) {
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    email: r.email,
    joinedAt: r.joined_at,
    tasksCompleted: Number(r.tasks_completed ?? 0),
    totalTasks: Number(r.total_tasks ?? 0),
    progress: Number(r.total_tasks ?? 0) > 0
      ? Math.round((Number(r.tasks_completed ?? 0) / Number(r.total_tasks ?? 0)) * 100)
      : 0,
  }));
}

export function buildStats(taskCount: unknown, memberCount: unknown, roi: unknown) {
  return { totalTasks: Number(taskCount), completedTasks: 0, activeUsers: Number(memberCount), totalRoiDistributed: Number(roi ?? 0) };
}

/** One task's status for one enrollment, given the user's latest submission row (or undefined). */
export function mapTaskStatus(task: any, latestSubmission: { status?: string } | undefined) {
  return {
    taskId: task.id, taskName: task.name, taskType: task.task_type,
    rewardAmount: task.reward_amount, cost: task.cost ?? 0, profit: task.profit ?? 0,
    status: latestSubmission ? latestSubmission.status : null,
  };
}

export function mapEntityTaskEnrollment(enr: any, taskStatuses: ReturnType<typeof mapTaskStatus>[], totalTasks: number) {
  const done = taskStatuses.filter((t) => t.status === "approved" || t.status === "completed").length;
  return {
    enrollmentId: enr.id, vaultEntryId: enr.vault_entry_id,
    entitySerial: enr.entity_serial, entityName: enr.entity_name,
    category: enr.category, email: enr.email,
    twitterUsername: enr.twitter_username, discordUsername: enr.discord_username,
    status: enr.status,
    tasks: taskStatuses, completedTasks: done, totalTasks,
  };
}
