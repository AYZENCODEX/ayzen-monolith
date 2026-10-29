orig="/tmp/orig/AYZEN4X1-finance-fin02czip/artifacts/api-server/src/routes/"
new="/home/claude/work/AYZEN4X1-finance-fin02czip/artifacts/api-server/src/routes/"
APP="/home/claude/work/AYZEN4X1-finance-fin02czip/artifacts/api-server/src/projects/application/enrollment-billing"
def blk(p,a,b):
    s=open(p).read(); i=s.index(a); return s[i:s.index(b,i)]
tail='\nexport default router;\nexport { state } from "/tmp/diff7/prj07-stubs.mjs";\n'
T='''import { Router } from "express";
import { db, projectsTable, userProjectsTable, projectEnrollmentsTable, vaultEntriesTable } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
import { requireAuth, authorize, createNotification, broadcastEvent, logActivity, hasCreditBalance, chargeCredits } from "/tmp/diff7/prj07-stubs.mjs";
const teamLeaderEngine = {};
%s
const router = Router();
'''
ta='router.post("/teams/:id/enroll-project"'; tb='// ── POST /teams/:id/vault'
open("told.ts","w").write(T%""+blk(orig+"teams.ts",ta,tb)+tail)
open("tnew.ts","w").write(T%('import { checkEnrollCredits, chargeEnrollCredits } from "%s";'%APP)+blk(new+"teams.ts",ta,tb)+tail)
B='''import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, sensitiveWriteLimiter } from "/tmp/diff7/prj07-stubs.mjs";
function safeIds(ids: unknown[]): number[] {
  return ids.map(id => parseInt(String(id), 10)).filter(n => !isNaN(n) && n > 0);
}
%s
const router = Router();
'''
ba='router.post("/projects/bulk-enroll"'; bb='// ── POST /csv/export'
open("bold.ts","w").write(B%""+blk(orig+"bulk.ts",ba,bb)+tail)
open("bnew.ts","w").write(B%('import { checkEnrollCredits, chargeEnrollCredits } from "%s";'%APP)+blk(new+"bulk.ts",ba,bb)+tail)
