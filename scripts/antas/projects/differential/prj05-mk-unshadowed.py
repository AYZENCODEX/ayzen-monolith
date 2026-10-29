orig="/tmp/orig/AYZEN4X1-finance-fin02czip/artifacts/api-server/src/routes/projects.ts"
new="/home/claude/work/AYZEN4X1-finance-fin02czip/artifacts/api-server/src/routes/projects.ts"
def blk(p,start,end):
    s=open(p).read(); a=s.index(start); b=s.index(end,a); return s[a:b]
hdr='''import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "/tmp/diff6/prj05-stubs.mjs";
%s
const router = Router();
'''
tail='\nexport default router;\nexport { state } from "/tmp/diff6/prj05-stubs.mjs";\n'
o=blk(orig,'router.get("/projects/mine/enrolled-entities"','// GET /projects/mine/overview')
n=blk(new,'router.get("/projects/mine/enrolled-entities"','// GET /projects/mine/overview')
open("sold.ts","w").write(hdr%""+o+tail)
open("snew.ts","w").write(hdr%('import { getMineEnrolledEntities } from "%s/projects/application/enrollment-overview";'%"/home/claude/work/AYZEN4X1-finance-fin02czip/artifacts/api-server/src")+n+tail)
