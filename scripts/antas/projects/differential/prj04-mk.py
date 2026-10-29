orig="/tmp/orig/AYZEN4X1-finance-fin02czip/artifacts/api-server/src"
new="/home/claude/work/AYZEN4X1-finance-fin02czip/artifacts/api-server/src"
def block(path):
    s=open(path).read(); a=s.index('// ─── GET /projects/:id/roi-summary'); b=s.index('export default router;'); return s[a:b]
hdr='''import { Router } from "express";
import crypto from "crypto";
import { db, projectsTable, usersTable, entityProjectRoiTable, vaultEntriesTable, projectPnlReceiptsTable, financeLedgerEntriesTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requirePublicAudit, pepDecisionObserver, streamFantasticReceiptPdf } from "/tmp/diff5/prj04-stubs.mjs";
%s
const router = Router();
'''
tail='\nexport default router;\nexport { state } from "/tmp/diff5/prj04-stubs.mjs";\n'
open("old.ts","w").write(hdr%""+block(orig+"/routes/projects.ts")+tail)
open("new.ts","w").write(hdr%('import { getPublicReceipt, getPublicReceiptPdfSpec, getRoiSummary, mintPnlReceipt, revokePnlReceipt } from "%s/projects/application/roi-receipts";'%new)+block(new+"/routes/projects.ts")+tail)
