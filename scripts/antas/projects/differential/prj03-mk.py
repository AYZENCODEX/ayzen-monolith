import re
orig="/tmp/orig/AYZEN4X1-finance-fin02czip/artifacts/api-server/src"
new="/home/claude/work/AYZEN4X1-finance-fin02czip/artifacts/api-server/src"
def block(path):
    s=open(path).read()
    a=s.index('router.get("/projects/:id/ratings", async'); b=s.index('// ─── GET /projects/:id/roi-summary')
    return s[a:b]
hdr='''import { Router } from "express";
import { db, projectsTable, projectRatingsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { broadcastEvent } from "./events";
%s
const router = Router();
'''
tail='\nexport default router;\nexport { state } from "/tmp/diff3/prj03-stubs.mjs";\n'
open("rold.ts","w").write(hdr%""+block(orig+"/routes/projects.ts")+tail)
open("rnew.ts","w").write(hdr%('import { getMyRating, getProjectRatings, removeMyRating, removeRatingById, submitRating } from "%s/projects/application/ratings";'%new)+block(new+"/routes/projects.ts")+tail)
for n,root in (("told",orig),("tnew",new)):
    open(n+".ts","w").write('export { default } from "%s/routes/project-templates.ts";\nexport { state } from "/tmp/diff3/prj03-stubs.mjs";\n'%root)
