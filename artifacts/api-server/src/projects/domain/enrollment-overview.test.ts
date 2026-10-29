import assert from "node:assert/strict";
import test from "node:test";
import { formatAdminEnrollmentEntity, formatEnrollmentEntity, groupEnrolledEntities, mapMineEnrolled } from "./enrollment-overview";

test("mapMineEnrolled coerces ids and counts", () => {
  assert.deepEqual(mapMineEnrolled([{ project_id: "1", project_name: "A", thumbnail_url: null, category: "c", enrolled_count: "2" }]),
    [{ projectId: 1, projectName: "A", thumbnailUrl: null, category: "c", enrolledCount: 2 }]);
});

test("groupEnrolledEntities groups by entity and flags ongoing/past (project status default active)", () => {
  const r = (e: number, p: number, st: string | null) => ({ vault_entry_id: e, entity_serial: "S", entity_name: "N", category: "c", project_id: p, project_name: "P" + p, project_status: st, project_thumbnail_url: null, enrollment_status: "active", enrolled_at: "d" });
  const g = groupEnrolledEntities([r(10, 1, "active"), r(10, 2, "completed"), r(11, 3, null), r(12, 4, "archived"), r(13, 5, "paused")]);
  assert.deepEqual(g.map((e) => [e.vaultEntryId, e.hasOngoing, e.hasPast, e.projects.length]), [[10, true, true, 2], [11, true, false, 1], [12, false, true, 1], [13, true, false, 1]]);
  assert.equal(g[1].projects[0].projectStatus, "active");
});

test("entity shapes tolerate a missing vault row", () => {
  assert.equal(formatEnrollmentEntity(null), null);
  assert.equal(formatAdminEnrollmentEntity(undefined), null);
  assert.deepEqual(formatEnrollmentEntity({ id: 1, walletAddresses: '["0x"]' }).walletAddresses, ["0x"]);
  assert.deepEqual(formatEnrollmentEntity({ id: 1, walletAddresses: null }).walletAddresses, []);
  assert.deepEqual(formatAdminEnrollmentEntity({ id: 1, entitySerial: "S", projectName: "N", category: "c", email: "hidden" }), { id: 1, entitySerial: "S", projectName: "N", category: "c" });
});
