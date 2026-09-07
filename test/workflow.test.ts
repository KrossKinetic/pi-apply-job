import assert from "node:assert/strict";
import test from "node:test";
import { buildPipelinePrompt, coordinatorProcessIsLive, extractJobInfo, isActiveProviderExtension, workerSystemPrompt } from "../extensions/workflow.js";
import { workerSubmissionProtocol } from "../extensions/worker-submissions.js";
import { isPublicHttpUrl } from "../extensions/index.js";

test("worker prompt enforces targeted selection and leaves rendering to the coordinator", () => {
	const prompt = buildPipelinePrompt("/tmp/job", "Example Co", "Platform Engineer", {
		rootDir: "/tmp/.pi/apply-job",
		jobsDir: "/tmp/.pi/apply-job/jobs",
		masterDir: "/tmp/.pi/apply-job/master",
		templateDir: "/tmp/.pi/apply-job/master/template",
		coverLetterDir: "/tmp/.pi/apply-job/master/cover-letter",
	});

	assert.match(prompt, /4–7 most important requirements/);
	assert.match(prompt, /exactly 5 stable heading IDs/);
	assert.match(prompt, /3 work \+ 2 projects or 4 work \+ 1 project/);
	assert.match(prompt, /workExperience is ordered/);
	assert.match(prompt, /optional \[3\]/);
	assert.match(prompt, /Coursework must render in exactly 2 PDF lines/);
	assert.match(prompt, /at most 3 PDF lines total/);
	assert.match(prompt, /must be split into two résumé bullets rather than restated/);
	assert.match(prompt, /Each project has exactly 1 bullet/);
	assert.match(prompt, /Each workExperience\/project item contains only the stable heading id and its tailored bullet/);
	assert.match(prompt, /do not include schemaVersion, target, header, education/);
	assert.match(prompt, /never a JSON-encoded string or a value nested under a resumePlan key/);
	assert.match(prompt, /First-three-job bullets should land at 2 PDF lines/);
	assert.doesNotMatch(prompt, /4–6 experience bullets/);
	assert.match(prompt, /projected or estimated result must retain both its qualifier and attribution/);
	assert.match(prompt, /source-bullet boundaries are not résumé-bullet boundaries/);
	assert.match(prompt, /compressed STAR form/);
	assert.match(prompt, /Prefer an impactful evidenced metric/);
	assert.match(prompt, /never invent, calculate, round, strengthen, or de-attribute a metric/);
	assert.match(prompt, /may synthesize complementary atomic facts from multiple master source blocks/);
	assert.match(prompt, /read_draft_source/);
	assert.match(prompt, /job_brief/);
	assert.match(prompt, /master_resume/);
	assert.doesNotMatch(prompt, /job-requirement\.json|resume-plan\.json|resume\.md|job\.md|master\/resume|no path argument|search for files/);
	assert.match(prompt, /The coordinator owns rendering/);
	assert.doesNotMatch(prompt, /verification\.approved/);
	assert.doesNotMatch(prompt, /apply_job_render_resume/);
});


test("retains only the selected provider lifecycle extension", () => {
	assert.equal(isActiveProviderExtension("/Users/example/.pi/agent/npm/node_modules/pi-mtplx/extensions/mtplx.ts", "mtplx"), true);
	assert.equal(isActiveProviderExtension("/Users/example/.pi/agent/npm/node_modules/pi-mtplx/extensions/mtplx.ts", "deepinfra"), false);
});

test("drafter and reviewers receive concise role-specific résumé craft guidance", () => {
	assert.match(workerSystemPrompt("draft", "resume_draft"), /fast human skim and basic applicant-tracking parsing/);
	assert.match(workerSystemPrompt("draft", "resume_draft"), /3 work entries at 3\/3\/2 bullets/);
	assert.match(workerSystemPrompt("draft", "resume_draft"), /Do not recast the same project/);
	assert.match(workerSystemPrompt("draft", "resume_draft"), /compressed STAR form/);
	assert.match(workerSystemPrompt("draft", "resume_draft"), /never invent a metric/);
	assert.match(workerSystemPrompt("draft", "resume_draft"), /read_draft_source \(job_brief then master_resume\)/);
	assert.match(workerSystemPrompt("facts", "facts_review"), /read the audit packet with read_facts_packet/);
	assert.match(workerSystemPrompt("facts", "facts_review"), /every atomic assertion/);
	assert.match(workerSystemPrompt("requirements", "requirements"), /read the job posting with read_job_posting/);
	assert.match(workerSystemPrompt("editor", "targeted_patch"), /read the repair packet with read_editor_packet/);
	assert.match(workerSystemPrompt("editor", "targeted_patch"), /Submit one patch per allowlisted path/);
	assert.match(workerSystemPrompt("editor", "targeted_patch"), /Never make a general quality, ATS, coverage, or keyword change/);
	for (const prompt of [workerSystemPrompt("draft", "resume_draft"), workerSystemPrompt("facts", "facts_review"), workerSystemPrompt("editor", "targeted_patch"), workerSystemPrompt("requirements", "requirements")]) {
		assert.doesNotMatch(prompt, /job-requirement\.json|resume-plan\.json|resume\.md|job\.md|\.review-packet|no path argument|search for files|filesystem/);
	}
});

test("every worker receives an explicit tool-only completion protocol", () => {
	for (const [kind, tool] of [
		["requirements", "submit_requirements"],
		["resume_draft", "submit_resume_draft"],
		["facts_review", "submit_factual_review"],
		["targeted_patch", "submit_targeted_patch"],
		["cover_letter", "submit_cover_letter"],
		["cover_letter_review", "submit_cover_letter_review"],
	] as const) {
		const protocol = workerSubmissionProtocol(kind);
		assert.match(protocol, new RegExp("final action in this conversation must be exactly one call to the `" + tool + "` tool"));
		assert.match(protocol, /Do not put the completed artifact in a chat message/);
		assert.match(protocol, /matches the tool's schema exactly/);
		if (kind === "cover_letter" || kind === "cover_letter_review") assert.match(protocol, /never search or guess filenames/);
		else assert.match(protocol, /Read assigned sources with `read_/);
	}
});

test("prefers the posting's actual role over an overlong page title", () => {
	const info = extractJobInfo({
		url: "https://careers.mastercard.com/us/en/job/R-287618/example",
		title: "Software Engineer Intern, Summer 2027 – United States in O Fallon, United States of America at Mastercard",
		heading: null,
		description: null,
		body: "Title and Summary\nSoftware Engineer Intern, Summer 2027 – United States\nWhat you will do",
		error: null,
	});
	assert.equal(info.companyName, "Mastercard");
	assert.equal(info.roleName, "Software Engineer Intern, Summer 2027 – United States");
});

test("job URL validation rejects local and non-public IP literals", () => {
	for (const url of ["http://127.0.0.1/job", "http://2130706433/job", "http://10.0.0.2/job", "http://169.254.169.254/latest/meta-data", "http://[::1]/job", "http://[fd00::1]/job", "http://192.0.2.1/job"]) {
		assert.equal(isPublicHttpUrl(url), false, url);
	}
	assert.equal(isPublicHttpUrl("https://example.com/jobs/1"), true);
});

test("stale coordinator locks are not treated as a live owner", () => {
	assert.equal(coordinatorProcessIsLive(process.pid), true);
	assert.equal(coordinatorProcessIsLive(Number.NaN), false);
	assert.equal(coordinatorProcessIsLive(-1), false);
	assert.equal(coordinatorProcessIsLive(2_000_000_000), false);
});
