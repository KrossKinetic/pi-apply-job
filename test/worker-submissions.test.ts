import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { buildLedger } from "../extensions/evidence.js";
import { writeEditorPacket, writeReviewPacket } from "../extensions/review-engine.js";
import { createWorkerReadTool, createWorkerSubmissionTool, submissionToolName, validateWorkerSubmission, type WorkerSubmissionKind } from "../extensions/worker-submissions.js";
import { planFixture, planSubmissionFixture, setup } from "./fixtures.js";
import { writeJsonFile } from "../extensions/utils.js";

const brief = { schemaVersion: 1 as const, job: { company: "Example", role: "Engineer", roleQuote: "Example" }, summary: { text: "Python and testing.", quotes: ["Requires Python and automated testing."] }, details: [], requirements: [{ id: "R1", text: "Python", quote: "Requires Python and automated testing.", importance: "core" as const }], skills: [{ name: "Python", quote: "Requires Python and automated testing.", importance: "core" as const }], responsibilities: [] };
const draft = () => planSubmissionFixture();

test("worker submissions expose no writable path and include the new patch gate", () => {
  const f = setup();
  try {
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    const kinds: WorkerSubmissionKind[] = ["requirements", "resume_draft", "facts_review", "targeted_patch", "cover_letter", "cover_letter_review"];
    for (const kind of kinds) {
      const schema = createWorkerSubmissionTool(kind, context).tool.parameters as { additionalProperties?: boolean; properties?: Record<string, unknown> };
      assert.equal(schema.additionalProperties, false); assert.equal(schema.properties?.path, undefined); assert.ok(submissionToolName(kind).startsWith("submit_"));
    }
  } finally { f.cleanup(); }
});

test("initial Low worker owns the quote-validated job brief, separate from the draft", () => {
  const f = setup();
  try {
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    const schema = createWorkerSubmissionTool("resume_draft", context).tool.parameters;
		assert.equal(Check(schema, draft()), true);
		assert.equal(Check(schema, { resumePlan: draft() }), false);
		assert.equal(Check(schema, { ...draft(), verification: { approved: true } }), false);
    assert.equal(Check(schema, { ...draft(), jobRequirement: brief }), false);
    assert.doesNotThrow(() => validateWorkerSubmission("resume_draft", draft(), context));
    assert.doesNotThrow(() => validateWorkerSubmission("resume_draft", planFixture(), context));
  } finally { f.cleanup(); }
});

test("factual reviewer and targeted editor have separate, narrow contracts", () => {
  const f = setup();
  try {
    f.draft();
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    assert.doesNotThrow(() => validateWorkerSubmission("facts_review", { approved: false, summary: "Wrong metric.", issues: [{ path: "/workExperience/0/bullets/0/text", clause: "50%", reason: "Unsupported.", evidence: ["role-03"] }] }, context));
    assert.doesNotThrow(() => validateWorkerSubmission("targeted_patch", { patches: [{ targetPath: "/workExperience/0/bullets/0/text", replacement: "Reduced latency.", evidence: ["role-03"] }] }, context));
  } finally { f.cleanup(); }
});

test("coordinator gates that used to fail after a completed tool call now reject inside validation", () => {
  const f = setup();
  try {
    f.draft();
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    assert.throws(() => validateWorkerSubmission("requirements", { ...brief, job: { ...brief.job, company: "Google" } }, context), /must exactly match the assigned company/);
    assert.doesNotThrow(() => validateWorkerSubmission("requirements", brief, context));
    const allowed = ["/workExperience/0/bullets/0/text"];
    assert.throws(() => validateWorkerSubmission("targeted_patch", { patches: [{ targetPath: "/workExperience/0/title", replacement: "Changed", evidence: ["role-01"] }] }, { ...context, allowedPatchPaths: allowed }), /Edit denied/);
    assert.doesNotThrow(() => validateWorkerSubmission("targeted_patch", { patches: [{ targetPath: "/workExperience/0/bullets/0/text", replacement: "Reduced latency.", evidence: ["role-03"] }] }, { ...context, allowedPatchPaths: allowed }));
  } finally { f.cleanup(); }
});

test("worker read access stays restricted to coordinator inputs", async () => {
  const f = setup();
  try {
    const reader = createWorkerReadTool("requirements", { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" });
    assert.equal(reader.name, "read_job_posting");
    assert.equal((reader.parameters as { properties?: { path?: unknown } }).properties?.path, undefined);
    const allowed = await reader.execute("read", {} as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(allowed), /Requires Python/);
  } finally { f.cleanup(); }
});

test("fixed read tools return the coordinator-assigned source without a path", async () => {
  const f = setup();
  try {
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    const editor = createWorkerReadTool("targeted_patch", context);
    assert.equal(editor.name, "read_editor_packet");
    assert.equal((editor.parameters as { properties?: { path?: unknown } }).properties?.path, undefined);
    f.draft();
    const masterText = fs.readFileSync(path.join(f.workspace.masterDir, "resume.md"), "utf8");
    writeEditorPacket(f.folder, masterText, {
      kind: "factual",
      allowlist: ["/workExperience/0/bullets/0/text"],
      issues: [{ path: "/workExperience/0/bullets/0/text", clause: "50%", reason: "Unsupported.", evidence: ["role-03"] }],
    });
    const packet = await editor.execute("read", {} as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(packet), /targeted-repair/);
    assert.equal((packet as { details?: { path?: string; source?: string } }).details?.path, undefined);
    assert.equal((packet as { details?: { source?: string } }).details?.source, "read_editor_packet");
    assert.doesNotMatch(editor.description, /resume-plan\.json|path argument|\.json/);
    writeReviewPacket(f.folder, masterText, buildLedger(planFixture(), masterText));
    const facts = createWorkerReadTool("facts_review", context);
    assert.equal(facts.name, "read_facts_packet");
    assert.equal((facts.parameters as { properties?: { path?: unknown } }).properties?.path, undefined);
    assert.doesNotMatch(facts.description, /path argument|\.json/);
    const audit = await facts.execute("read", {} as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(audit), /factual-audit/);
    assert.equal((audit as { details?: { path?: string; source?: string } }).details?.path, undefined);
    assert.equal((audit as { details?: { source?: string } }).details?.source, "read_facts_packet");
    const drafter = createWorkerReadTool("resume_draft", context);
    assert.equal(drafter.name, "read_draft_source");
    assert.match(drafter.description, /job_brief/);
    assert.match(drafter.description, /master_resume/);
    assert.doesNotMatch(drafter.description, /resume\.md|job-requirement|\.json|path argument/);
    assert.equal((drafter.parameters as { properties?: { path?: unknown } }).properties?.path, undefined);
    const master = await drafter.execute("read", { source: "master_resume" } as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(master), /Example Candidate/);
    writeJsonFile(path.join(f.folder, "job-requirement.json"), { job: { company: "Example" } });
    const brief = await drafter.execute("read", { source: "job_brief" } as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(brief), /Example/);
    f.draft();
    await assert.rejects(drafter.execute("read", { path: path.join(f.folder, "resume-plan.json") } as never, undefined, undefined, {} as never), /source|Invalid|required/);
  } finally { f.cleanup(); }
});

test("malformed JSON-encoded nested fields dump the entire tool arguments", () => {
  const f = setup();
  try {
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    const broken = `{"items":["Algorithms","Systems","${"Distributed Computing ".repeat(20).trim()}"],"evidence":["edu-03"`;
    const payload = { ...draft(), coursework: broken };
    assert.throws(() => validateWorkerSubmission("resume_draft", payload, context), (error: Error) => {
      assert.match(error.message, /coursework was submitted as a JSON-encoded string but failed to parse as JSON/);
      assert.match(error.message, /Broken field coursework:/);
      assert.match(error.message, /Full tool arguments:/);
      assert.equal(error.message.includes("…"), false);
      assert.ok(error.message.includes(broken));
      assert.ok(error.message.includes(payload.skills[0]!.value));
      return true;
    });
  } finally { f.cleanup(); }
});

test("drafter must submit the 3/3/2 work-bullet block", () => {
  const f = setup();
  try {
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    const sparse = draft();
    sparse.workExperience[0] = { ...sparse.workExperience[0]!, bullets: sparse.workExperience[0]!.bullets.slice(0, 2) };
    assert.throws(() => validateWorkerSubmission("resume_draft", sparse, context), /workExperience\[0\] must have 3 bullets/);
  } finally { f.cleanup(); }
});

test("drafter cannot select registered or planned coursework", () => {
  const f = setup();
  try {
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    const planned = draft();
    planned.coursework = { items: ["Compiler Design", "Data Structures"], evidence: ["edu-03"] };
    assert.throws(() => validateWorkerSubmission("resume_draft", planned, context), /registered or planned course/);
  } finally { f.cleanup(); }
});

test("drafter cannot recast the same distinctive topic across a three-bullet work entry", () => {
  const f = setup();
  try {
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    const recast = draft();
    recast.workExperience[0] = {
      ...recast.workExperience[0]!,
      bullets: [
        { text: "Built an MCP server for investigation workflows with FastAPI transports.", evidence: ["role-02"] },
        { text: "Designed MCP tool composition so non-engineers can chain existing jobs.", evidence: ["role-03"] },
        { text: "Used MCP agents to cut a manual workflow by 50% through caching.", evidence: ["role-04"] },
      ],
    };
    assert.throws(() => validateWorkerSubmission("resume_draft", recast, context), /every bullet repeats MCP/);
  } finally { f.cleanup(); }
});
