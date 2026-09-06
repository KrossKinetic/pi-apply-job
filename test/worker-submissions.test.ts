import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { createWorkerReadTool, createWorkerSubmissionTool, submissionToolName, validateWorkerSubmission, type WorkerSubmissionKind } from "../extensions/worker-submissions.js";
import { planSubmissionFixture, setup } from "./fixtures.js";

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
  } finally { f.cleanup(); }
});

test("factual reviewer and targeted editor have separate, narrow contracts", () => {
  const f = setup();
  try {
    f.draft();
    const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
    assert.doesNotThrow(() => validateWorkerSubmission("facts_review", { approved: false, summary: "Wrong metric.", issues: [{ path: "/workExperience/0/bullets/1/text", clause: "50%", reason: "Unsupported.", evidence: ["role-03"] }] }, context));
    assert.doesNotThrow(() => validateWorkerSubmission("targeted_patch", { patches: [{ targetPath: "/workExperience/0/bullets/1/text", replacement: "Reduced latency.", evidence: ["role-03"] }] }, context));
  } finally { f.cleanup(); }
});

test("worker read access stays restricted to coordinator inputs", async () => {
  const f = setup();
  try {
    const reader = createWorkerReadTool("requirements", { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" });
    const allowed = await reader.execute("read", { path: path.join(f.folder, "job.md") } as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(allowed), /Requires Python/);
    await assert.rejects(reader.execute("read", { path: path.join(f.workspace.masterDir, "resume.md") } as never, undefined, undefined, {} as never), /outside this worker/);
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
