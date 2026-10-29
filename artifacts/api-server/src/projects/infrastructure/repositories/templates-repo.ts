// projects/infrastructure/repositories/templates-repo.ts
// The single repository over the `ayzen_project_templates` table (PRJ-03). Repositories only run queries.
// The two transactional writes keep the original "clear the previous default holder, then write" atomicity.
import { db, projectTemplatesTable } from "@workspace/db";
import { eq, desc, sql, and, ne } from "drizzle-orm";
import type { TemplateUpdates } from "../../domain/template";

export function listTemplates() {
  return db.select().from(projectTemplatesTable).orderBy(desc(projectTemplatesTable.updatedAt));
}

export async function findTemplate(id: number) {
  const [row] = await db.select().from(projectTemplatesTable).where(eq(projectTemplatesTable.id, id));
  return row;
}

export function insertTemplateClearingDefault(values: {
  name: string; description: string | null; data: string; folder: string | null;
  defaultForProjectType: string | null; createdBy: number;
}) {
  return db.transaction(async (tx) => {
    if (values.defaultForProjectType) {
      await tx.update(projectTemplatesTable).set({ defaultForProjectType: null })
        .where(eq(projectTemplatesTable.defaultForProjectType, values.defaultForProjectType));
    }
    const [inserted] = await tx.insert(projectTemplatesTable).values(values).returning();
    return inserted;
  });
}

export function updateTemplateClearingDefault(id: number, updates: TemplateUpdates, nextDefaultType: string | null | undefined) {
  return db.transaction(async (tx) => {
    if (nextDefaultType) {
      await tx.update(projectTemplatesTable).set({ defaultForProjectType: null })
        .where(and(eq(projectTemplatesTable.defaultForProjectType, nextDefaultType), ne(projectTemplatesTable.id, id)));
    }
    const [updated] = await tx.update(projectTemplatesTable).set(updates).where(eq(projectTemplatesTable.id, id)).returning();
    return updated;
  });
}

export async function deleteTemplate(id: number) {
  const [deleted] = await db.delete(projectTemplatesTable).where(eq(projectTemplatesTable.id, id)).returning();
  return deleted;
}

export async function bumpTemplateUsage(id: number) {
  const [row] = await db.update(projectTemplatesTable)
    .set({ usageCount: sql`${projectTemplatesTable.usageCount} + 1` })
    .where(eq(projectTemplatesTable.id, id))
    .returning();
  return row;
}

/** Case-insensitive name check (names are unique on lower(name)). */
export async function templateNameTaken(name: string): Promise<boolean> {
  const [clash] = await db.select({ id: projectTemplatesTable.id }).from(projectTemplatesTable)
    .where(sql`lower(${projectTemplatesTable.name}) = lower(${name})`);
  return Boolean(clash);
}

export async function insertTemplate(values: {
  name: string; description: string | null; data: string; folder: string | null; createdBy: number;
}) {
  const [row] = await db.insert(projectTemplatesTable).values(values).returning();
  return row;
}
