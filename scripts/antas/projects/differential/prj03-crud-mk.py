orig="/tmp/orig/AYZEN4X1-finance-fin02czip/artifacts/api-server/src"
new="/home/claude/work/AYZEN4X1-finance-fin02czip/artifacts/api-server/src"
def parts(path):
    s=open(path).read()
    a=s.index('/** Optional auth for public routes'); b=s.index('// GET /projects/entity/:vaultEntryId/overview')
    helpers=s[a:b]
    c=s.index('router.get("/projects", async'); d=s.index('router.post("/projects/:id/join"')
    return helpers, s[c:d]
hdr='''import { Router } from "express";
import { db, projectsTable, userProjectsTable, tasksTable, projectEnrollmentsTable } from "@workspace/db";
import { eq, ilike, and, count, sql } from "drizzle-orm";
import { requireAdmin, requireAuth, requireRoles } from "../middlewares/auth";
import { broadcastEvent } from "./events";
import { syncOnProjectDelete } from "../services/sync";
%s
const router = Router();
'''
tail='\nexport default router;\nexport { state } from "/tmp/diff4/prj03-crud-stubs.mjs";\n'
h,b=parts(orig+"/routes/projects.ts")
open("cold.ts","w").write(hdr%""+h+b+tail)
h2,b2=parts(new+"/routes/projects.ts")
imp='import { createProject, deleteProject, getProjectDetail, listProjects, updateProject } from "%s/projects/application/projects";'%new
open("cnew.ts","w").write(hdr%imp+h2+b2+tail)
