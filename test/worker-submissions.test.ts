import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { Compile } from "typebox/compile";
import { createWorkerReadTool, createWorkerSubmissionTool, persistResumeDraft, type ResumeDraftSubmission, type WorkerSubmissionKind } from "../extensions/worker-submissions.js";
import { planFixture, setup } from "./fixtures.js";

const analysis = {
	fitScore: 8,
	strengths: ["Direct testing evidence"],
	weaknesses: [],
	explicitMatches: ["Python"],
	implicitSkills: [{ skill: "Reliability", evidence: ["role-02"] }],
	missingRequirements: [],
	resumeRecommendations: ["Lead with testing impact"],
};

test("worker reads are restricted to the role's coordinator-assigned files", async () => {
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const reader = createWorkerReadTool("requirements", context);
		const allowed = await reader.execute("read-1", { path: path.join(f.folder, "job.md") } as never, undefined, undefined, {} as never);
		assert.match(JSON.stringify(allowed), /Requires Python/);
		const unrelated = path.join(f.root, "unrelated.txt");
		fs.writeFileSync(unrelated, "private");
		await assert.rejects(
			reader.execute("read-2", { path: unrelated } as never, undefined, undefined, {} as never),
			/outside this worker's assigned read set/,
		);
	} finally { f.cleanup(); }
});

test("every worker submission tool has a closed top-level schema and no path argument", () => {
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const kinds: WorkerSubmissionKind[] = ["requirements", "resume_draft", "verification", "facts_review", "quality_review", "cover_letter", "cover_letter_review"];
		for (const kind of kinds) {
			const schema = createWorkerSubmissionTool(kind, context).tool.parameters as unknown as { additionalProperties?: boolean; properties?: Record<string, unknown> };
			assert.equal(schema.additionalProperties, false, `${kind} must reject unknown fields`);
			assert.equal(schema.properties?.path, undefined, `${kind} must not accept a caller-selected path`);
		}
	} finally { f.cleanup(); }
});

test("submission schemas reject wrong types and arbitrary path fields before execution", () => {
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const verification = createWorkerSubmissionTool("verification", context).tool.parameters;
		assert.equal(Check(verification, { approved: true, issues: [], summary: "Checked." }), true);
		assert.equal(Check(verification, { approved: [], issues: [], summary: { status: "approved" } }), false);
		assert.equal(Check(verification, { approved: true, issues: [], summary: "Checked.", path: "/tmp/escape.json" }), false);

		const draft = createWorkerSubmissionTool("resume_draft", context).tool.parameters;
		assert.equal(Check(draft, { analysis, resumePlan: planFixture(), verification: { approved: true, issues: [], summary: "Checked." } }), true);
		assert.equal(Check(draft, { analysis, resumePlan: planFixture(), verification: { approved: true, issues: [] } }), false);
		const oversized = planFixture();
		oversized.header.headline = "x".repeat(4_001);
		assert.equal(Check(draft, { analysis, resumePlan: oversized, verification: { approved: true, issues: [], summary: "Checked." } }), false);

		// The visible schema itself — not prose — must reject the exact defects the
		// handoff called out: free-text section titles, optional work-entry fields,
		// and a project with more than one bullet.
		const missingRequiredFields = planFixture() as unknown as Record<string, unknown>;
		delete (missingRequiredFields.workExperience as Array<Record<string, unknown>>)[0].subtitle;
		assert.equal(Check(draft, { analysis, resumePlan: missingRequiredFields, verification: { approved: true, issues: [], summary: "Checked." } }), false);
		const legacyShape = { ...planFixture(), sections: [{ title: "Work Experience", kind: "entries", entries: [] }] } as unknown as Record<string, unknown>;
		delete legacyShape.workExperience;
		delete legacyShape.projects;
		assert.equal(Check(draft, { analysis, resumePlan: legacyShape, verification: { approved: true, issues: [], summary: "Checked." } }), false);
		const tooManyProjectBullets = planFixture();
		tooManyProjectBullets.projects[0].bullets.push(tooManyProjectBullets.projects[0].bullets[0]);
		assert.equal(Check(draft, { analysis, resumePlan: tooManyProjectBullets, verification: { approved: true, issues: [], summary: "Checked." } }), false);
	} finally { f.cleanup(); }
});

test("the exposed tool schema itself tolerates a double-serialized resumePlan the way the runtime's pre-execute validator does", () => {
	// The agent runtime compiles `tool.parameters` and Check()s the raw tool-call
	// arguments BEFORE execute() ever runs (see @earendil-works/pi-ai's
	// validateToolArguments). A rejection there never reaches our code, so the
	// exposed schema itself — not just our execute()-time coercion — must
	// tolerate a provider that double-serializes resumePlan as a JSON string.
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const wireSchema = createWorkerSubmissionTool("resume_draft", context).tool.parameters;
		const validator = Compile(wireSchema as never);
		const stringified = { analysis, resumePlan: JSON.stringify(planFixture()), verification: { approved: true, issues: [], summary: "Checked." } };
		assert.equal(validator.Check(stringified), true, "runtime-level validation must not reject a stringified resumePlan");
		const stillRejectsGarbage = { analysis, resumePlan: 12345, verification: { approved: true, issues: [], summary: "Checked." } };
		assert.equal(validator.Check(stillRejectsGarbage), false);
	} finally { f.cleanup(); }
});

test("a double-serialized resumePlan JSON string is coerced instead of rejected as 'must be object'", async () => {
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const submission = createWorkerSubmissionTool("resume_draft", context);
		const result = await submission.tool.execute("test", {
			analysis,
			resumePlan: JSON.stringify(planFixture()),
			verification: { approved: true, issues: [], summary: "Checked." },
		} as never, undefined, undefined, {} as never);
		assert.doesNotMatch(JSON.stringify(result), /must be object/);
		const consumed = submission.consume() as { resumePlan: { workExperience: unknown[] } };
		assert.equal(consumed.resumePlan.workExperience.length, 3);
	} finally { f.cleanup(); }
});

test("a malformed (e.g. truncated) resumePlan string gets an actionable parse error, not a bare 'must be object'", async () => {
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const submission = createWorkerSubmissionTool("resume_draft", context);
		await assert.rejects(
			submission.tool.execute("test", {
				analysis,
				resumePlan: '{"schemaVersion":2,"target":{"company":"Example"', // truncated
				verification: { approved: true, issues: [], summary: "Checked." },
			} as never, undefined, undefined, {} as never),
			/resumePlan was submitted as a JSON-encoded string but failed to parse as JSON/,
		);
	} finally { f.cleanup(); }
});

test("a resumePlan string wrapped in a Markdown code fence is still recovered", async () => {
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const submission = createWorkerSubmissionTool("resume_draft", context);
		await submission.tool.execute("test", {
			analysis,
			resumePlan: "```json\n" + JSON.stringify(planFixture()) + "\n```",
			verification: { approved: true, issues: [], summary: "Checked." },
		} as never, undefined, undefined, {} as never);
		const consumed = submission.consume() as { resumePlan: { workExperience: unknown[] } };
		assert.equal(consumed.resumePlan.workExperience.length, 3);
	} finally { f.cleanup(); }
});

test("quality-review alternatives may cite no evidence for an absence-based exclusion", () => {
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const schema = createWorkerSubmissionTool("quality_review", context).tool.parameters;
		const value = {
			approved: true, issues: [], summary: "No material improvement remains.",
			coverage: [], alternatives: [{ evidence: [], reason: "No accessibility evidence exists in the master resume." }],
		};
		assert.equal(Check(schema, value), true);
	} finally { f.cleanup(); }
});

test("submission execution reports the first invalid field even if SDK validation is bypassed", async () => {
	const f = setup();
	try {
		const submission = createWorkerSubmissionTool("verification", { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" });
		await assert.rejects(
			submission.tool.execute("test", { approved: [], issues: [], summary: "Checked." } as never, undefined, undefined, {} as never),
			/Invalid verification submission at \/approved/,
		);
	} finally { f.cleanup(); }
});

test("semantic rejection returns before any coordinator artifact is changed", async () => {
	const f = setup();
	try {
		f.draft();
		const before = fs.readFileSync(path.join(f.folder, "resume-plan.json"), "utf8");
		const invalid = planFixture();
		invalid.workExperience[0].bullets[0].evidence = ["invented-id"];
		const submission = createWorkerSubmissionTool("resume_draft", { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" });
		await assert.rejects(
			submission.tool.execute("test", { analysis, resumePlan: invalid, verification: { approved: true, issues: [], summary: "Checked." } } as never, undefined, undefined, {} as never),
			/Unknown master-resume evidence ID/,
		);
		assert.equal(fs.readFileSync(path.join(f.folder, "resume-plan.json"), "utf8"), before);
	} finally { f.cleanup(); }
});

test("submit_resume_draft itself catches a measured layout defect in the same worker turn", async () => {
	const f = setup();
	try {
		const context = { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" };
		const submission = createWorkerSubmissionTool("resume_draft", context);
		const broken = planFixture();
		broken.skills[0].value = "TypeScript, Python, JavaScript, ".repeat(20);
		// Layout is checked eagerly inside execute(), before the tool ever
		// terminates the worker session, so the drafter sees the finding and
		// can fix and resubmit without spending an independent-reviewer cycle.
		await assert.rejects(
			submission.tool.execute("test", { analysis, resumePlan: broken, verification: { approved: true, issues: [], summary: "Checked." } } as never, undefined, undefined, {} as never),
			/Measured PDF layout findings:.*Technical Skills/,
		);
		// A fixed resubmission in the same session now succeeds and persists.
		const fixed = planFixture();
		await submission.tool.execute("test", { analysis, resumePlan: fixed, verification: { approved: true, issues: [], summary: "Checked." } } as never, undefined, undefined, {} as never);
		const consumed = submission.consume() as { resumePlan: { workExperience: unknown[] } };
		assert.equal(consumed.resumePlan.workExperience.length, 3);
		assert.equal(JSON.parse(fs.readFileSync(path.join(f.folder, "layout.json"), "utf8")).passed, true);
	} finally { f.cleanup(); }
});

test("the coordinator derives markdown artifacts from one validated resume plan", async () => {
	const f = setup();
	try {
		const submission = createWorkerSubmissionTool("resume_draft", { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" });
		await submission.tool.execute("test", { analysis, resumePlan: planFixture(), verification: { approved: true, issues: [], summary: "Checked." } } as never, undefined, undefined, {} as never);
		persistResumeDraft(f.folder, submission.consume() as ResumeDraftSubmission);
		const preview = fs.readFileSync(path.join(f.folder, "resume.md"), "utf8");
		assert.match(preview, /# Example Candidate — Software Systems/);
		assert.match(preview, /Honors \/ Awards: Fellowship, Dean's List/);
		assert.match(preview, /### Systems Project — 2023/);
	} finally { f.cleanup(); }
});
