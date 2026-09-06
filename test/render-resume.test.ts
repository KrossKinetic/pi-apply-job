import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderPlan, renderResume } from "../extensions/render-resume.js";
import { planFixture, setup } from "./fixtures.js";

test("compiles a five-entry plan and rejects unknown evidence", async () => {
  const f = setup();
  try {
    f.draft();
    const result = await renderResume(f.workspace, f.folder);
    assert.equal(result.pageCount, 1);
    assert.equal(result.passed, true, JSON.stringify(result.warnings));
    assert.ok(fs.existsSync(path.join(f.folder,"resume-preview.png")));
    const tex = fs.readFileSync(result.texPath,"utf8");
    assert.match(tex, /Honors \/ Awards/);
    assert.match(tex, /Coursework/);
    assert.ok(!tex.includes("resizebox{"));
    const plan = planFixture(); plan.workExperience[0].bullets[0].evidence = ["invented-01"]; f.draft(plan);
    await assert.rejects(renderResume(f.workspace,f.folder),/unknown master-resume evidence ID/);
  } finally { f.cleanup(); }
});

test("long skills are reported rather than silently scaled to unreadable text", async () => {
  const f=setup();
  try {
    const plan=planFixture(); plan.skills[0].value="TypeScript, Python, JavaScript, ".repeat(20); f.draft(plan);
    const result=await renderResume(f.workspace,f.folder);
    assert.equal(result.passed,false);
    assert.ok(result.warnings.some(w=>w.includes("Technical Skills") || w.includes("overflowing")));
  } finally { f.cleanup(); }
});

test("a work bullet spanning more than two PDF lines fails layout QA", async () => {
  const f=setup();
  try {
    const plan=planFixture(), entry=plan.workExperience[0];
    entry.bullets[0].text="Implemented reliable service components with automated regression tests, deterministic input validation, structured error handling, documented recovery procedures, deployment safeguards, detailed observability, and cross-functional release coordination to support consistent releases across the engineering team.";
    f.draft(plan);
    const result=await renderResume(f.workspace,f.folder);
    assert.equal(result.passed,false);
    assert.equal(result.pageCount,1);
    assert.ok(result.warnings.some(w=>w.includes("bullet spanning")),JSON.stringify(result.warnings));
  } finally { f.cleanup(); }
});

test("renderer does not repeat a GPA already included in the degree value", () => {
  const plan=planFixture();
  plan.education.degree="B.S. in Computer Science Honors, GPA: 3.9/4.0";
  plan.education.gpa="3.9/4.0";
  const {content}=renderPlan(plan);
  assert.equal((content.match(/GPA:/g) || []).length,1);
  assert.match(content,/B\.S\. in Computer Science Honors -- GPA: 3\.9\/4\.0/);
});
