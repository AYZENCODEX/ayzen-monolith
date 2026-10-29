import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTemplateUpdates, duplicateTemplateName, formatTemplate, isTemplateNameClash, isValidTemplateName,
  parseJsonArray, pickTemplateData, templateInputFromProjectRow,
} from "./template";

// PRJ-03: pins the template rules moved out of routes/project-templates.ts.
const KEYS = ["tier", "badges", "xpName"] as const;

test("pickTemplateData keeps only allow-listed, non-empty values", () => {
  assert.deepEqual(pickTemplateData({ tier: "x", evil: 1, badges: ["a"], xpName: "", other: null }, KEYS), { tier: "x", badges: ["a"] });
  assert.deepEqual(pickTemplateData(null, KEYS), {});
  assert.deepEqual(pickTemplateData("str", KEYS), {});
  assert.deepEqual(pickTemplateData({ tier: null, badges: undefined }, KEYS), {});
});

test("formatTemplate parses data, tolerates corrupt data, ISO-formats dates", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  const row = { id: 1, name: "n", description: null, data: '{"a":1}', folder: null, usageCount: 2, defaultForProjectType: null, createdBy: 3, createdAt: d, updatedAt: d };
  assert.deepEqual(formatTemplate(row).data, { a: 1 });
  assert.deepEqual(formatTemplate({ ...row, data: "{oops" }).data, {});
  assert.equal(formatTemplate(row).updatedAt, d.toISOString());
});

test("name rules and clash detection", () => {
  assert.equal(isValidTemplateName("x"), true);
  for (const bad of ["", "  ", 5, null, undefined]) assert.equal(isValidTemplateName(bad), false);
  assert.equal(isTemplateNameClash(new Error('violates "ayzen_project_templates_name_key"')), true);
  assert.equal(isTemplateNameClash(new Error("other")), false);
  assert.equal(isTemplateNameClash(null), false);
  assert.equal(duplicateTemplateName("X", null), "Copy of X");
  assert.equal(duplicateTemplateName("X", 0), "Copy of X (2)");
  assert.equal(duplicateTemplateName("X", 3), "Copy of X (5)");
});

test("buildTemplateUpdates mirrors PATCH semantics", () => {
  const now = new Date("2026-02-02T00:00:00Z");
  assert.deepEqual(buildTemplateUpdates({}, KEYS, now), { updates: { updatedAt: now }, nextDefaultType: undefined });
  assert.deepEqual(buildTemplateUpdates({ name: "  " }, KEYS, now), { error: "name cannot be empty" });
  const r = buildTemplateUpdates({ name: " N ", description: " d ", folder: "", data: { tier: "t", z: 1 }, defaultForProjectType: "" }, KEYS, now);
  assert.ok("updates" in r);
  assert.deepEqual(r.updates, { updatedAt: now, name: "N", description: "d", folder: null, data: '{"tier":"t"}', defaultForProjectType: null });
  assert.equal(r.nextDefaultType, null);
});

test("project row to template input", () => {
  assert.deepEqual(parseJsonArray('["a"]'), ["a"]);
  assert.equal(parseJsonArray("oops{"), "oops{");
  assert.equal(parseJsonArray('{"a":1}'), '{"a":1}');
  assert.equal(parseJsonArray(""), "");
  const input = templateInputFromProjectRow({ project_type: "quest", tutorial_steps: '["s"]', badges: "x", name: "never" });
  assert.equal(input.projectType, "quest");
  assert.deepEqual(input.tutorialSteps, ["s"]);
  assert.equal(input.badges, "x");
  assert.ok(!("name" in input));
});
