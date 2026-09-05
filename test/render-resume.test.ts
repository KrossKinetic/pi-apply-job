import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderResume } from "../extensions/render-resume.js";
import { planFixture, setup } from "./fixtures.js";

test("compiles blank optional fields but fails sparse visual layout; rejects unknown evidence", async () => {
  const f = setup();
  try {
    f.draft();
    const result = await renderResume(f.workspace, f.folder);
    assert.equal(result.pageCount, 1);
    assert.equal(result.passed, false);
    assert.ok(result.warnings.some(w=>w.includes("Sparse")));
    assert.ok(fs.existsSync(path.join(f.folder,"resume-preview.png")));
    const tex = fs.readFileSync(result.texPath,"utf8");
    assert.match(tex, /Honors \/ Awards/);
    assert.match(tex, /Coursework/);
    assert.ok(!tex.includes("resizebox{"));
    const plan = planFixture(); plan.sections[0].entries[0].bullets[0].evidence = ["invented-01"]; f.draft(plan);
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

test("a balanced single-page fixture passes measured layout QA", async () => {
  const f=setup();
  try {
    const plan=planFixture(), entry=plan.sections[0].entries[0];
    entry.bullets.push({...entry.bullets[0]});
    for(const b of entry.bullets) b.text="Implemented reliable service components with automated regression tests, deterministic input validation, structured error handling, and documented recovery procedures to support consistent releases across the engineering team.";
    plan.sections[0].entries=Array.from({length:3},(_,i)=>({...entry,title:`Engineer ${i+1}`}));
    f.draft(plan);
    const result=await renderResume(f.workspace,f.folder);
    assert.equal(result.passed,true,JSON.stringify(result.warnings));
    assert.equal(result.pageCount,1);
  } finally { f.cleanup(); }
});
