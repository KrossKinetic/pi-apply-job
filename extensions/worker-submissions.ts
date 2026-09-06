/** Typed worker submissions. Workers never receive a filesystem mutation tool. */

import path from "node:path";
import fs from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { buildLedger, reviewLedger, sourceInventory, validateJobRequirement, validateReview } from "./evidence.js";
import { renderPlan, renderResume } from "./render-resume.js";
import type { CoverLetterReview, JobAnalysis, ResumePlan, VerificationResult } from "./schemas.js";
import { readJsonFile, readTextFile, writeJsonFile, writeTextFile, type ApplyJobWorkspace } from "./utils.js";

export type WorkerSubmissionKind =
	| "requirements"
	| "resume_draft"
	| "verification"
	| "facts_review"
	| "quality_review"
	| "cover_letter"
	| "cover_letter_review";

const nonEmpty = Type.String({ minLength: 1, maxLength: 4000 });
const optionalText = Type.String({ maxLength: 4000 });
const evidence = Type.Array(nonEmpty, { minItems: 1, maxItems: 16, uniqueItems: true });
const optionalEvidence = Type.Array(nonEmpty, { maxItems: 16, uniqueItems: true });
const issue = Type.Object({ claim: nonEmpty, reason: nonEmpty, evidence, suggestion: nonEmpty }, { additionalProperties: false });
const verificationIssue = Type.Object({ claim: nonEmpty, reason: nonEmpty }, { additionalProperties: false });
const requirement = Type.Object({
	id: nonEmpty,
	text: nonEmpty,
	quote: nonEmpty,
	importance: Type.Union([Type.Literal("core"), Type.Literal("supporting"), Type.Literal("optional")]),
}, { additionalProperties: false });
const sourceFact = Type.Object({ text: nonEmpty, quote: nonEmpty }, { additionalProperties: false });
const jobRequirement = Type.Object({
	schemaVersion: Type.Literal(1),
	job: Type.Object({ company: nonEmpty, role: nonEmpty, roleQuote: nonEmpty }, { additionalProperties: false }),
	summary: Type.Object({ text: nonEmpty, quotes: Type.Array(nonEmpty, { minItems: 1, maxItems: 6 }) }, { additionalProperties: false }),
	details: Type.Array(Type.Object({ label: nonEmpty, text: nonEmpty, quote: nonEmpty }, { additionalProperties: false }), { maxItems: 10 }),
	requirements: Type.Array(requirement, { minItems: 1, maxItems: 20 }),
	skills: Type.Array(Type.Object({ name: nonEmpty, quote: nonEmpty, importance: Type.Union([Type.Literal("core"), Type.Literal("supporting"), Type.Literal("optional")]) }, { additionalProperties: false }), { maxItems: 20 }),
	responsibilities: Type.Array(sourceFact, { maxItems: 12 }),
}, { additionalProperties: false });
const verification = Type.Object({
	approved: Type.Boolean(),
	issues: Type.Array(verificationIssue, { maxItems: 20 }),
	summary: nonEmpty,
}, { additionalProperties: false });
const bullet = Type.Object({ text: nonEmpty, evidence }, { additionalProperties: false });
/**
 * Work-experience entries are rendered under the fixed "Work Experience" heading.
 * dates/subtitle/location are required here — never optional — so the visible
 * schema cannot accept a payload that semantic validation would later reject.
 */
const standardEntry = Type.Object({
	title: nonEmpty,
	dates: nonEmpty,
	subtitle: nonEmpty,
	location: nonEmpty,
	bullets: Type.Array(bullet, { minItems: 2, maxItems: 3 }),
	evidence,
}, { additionalProperties: false });
/** Project entries are rendered under the fixed "Projects" heading with exactly one bullet. */
const projectEntry = Type.Object({
	title: nonEmpty,
	dates: Type.Optional(optionalText),
	bullets: Type.Array(bullet, { minItems: 1, maxItems: 1 }),
	evidence,
}, { additionalProperties: false });
const resumePlan = Type.Object({
	schemaVersion: Type.Literal(2),
	target: Type.Object({ company: nonEmpty, role: nonEmpty }, { additionalProperties: false }),
	header: Type.Object({ name: nonEmpty, headline: optionalText, contactLine: nonEmpty, evidence }, { additionalProperties: false }),
	education: Type.Object({
		institution: nonEmpty, degree: nonEmpty, gpa: optionalText, dates: nonEmpty, location: nonEmpty, evidence,
		honors: Type.Object({ items: Type.Array(nonEmpty, { maxItems: 4 }), evidence: optionalEvidence }, { additionalProperties: false }),
		coursework: Type.Object({ items: Type.Array(nonEmpty, { maxItems: 8 }), evidence: optionalEvidence }, { additionalProperties: false }),
	}, { additionalProperties: false }),
	skills: Type.Array(Type.Object({ label: nonEmpty, value: nonEmpty, evidence }, { additionalProperties: false }), { minItems: 2, maxItems: 3 }),
	// No free-text section titles: the renderer always emits "Work Experience"
	// then "Projects" (only if non-empty), so duplicate/misnamed/misordered
	// section titles are structurally impossible instead of prose-enforced.
	workExperience: Type.Array(standardEntry, { minItems: 3, maxItems: 5 }),
	projects: Type.Array(projectEntry, { minItems: 0, maxItems: 2 }),
}, { additionalProperties: false });
const analysis = Type.Object({
	fitScore: Type.Number({ minimum: 0, maximum: 10 }),
	strengths: Type.Array(nonEmpty, { maxItems: 20 }),
	weaknesses: Type.Array(nonEmpty, { maxItems: 20 }),
	explicitMatches: Type.Array(nonEmpty, { maxItems: 20 }),
	implicitSkills: Type.Array(Type.Object({ skill: nonEmpty, evidence }, { additionalProperties: false }), { maxItems: 20 }),
	missingRequirements: Type.Array(nonEmpty, { maxItems: 20 }),
	resumeRecommendations: Type.Array(nonEmpty, { maxItems: 20 }),
}, { additionalProperties: false });
const baseReview = {
	approved: Type.Boolean(),
	issues: Type.Array(issue, { maxItems: 20 }),
	summary: nonEmpty,
};
const coverage = Type.Object({
	requirementId: nonEmpty,
	status: Type.Union([Type.Literal("supported"), Type.Literal("unsupported_but_real"), Type.Literal("irrelevant")]),
	evidence: optionalEvidence,
	claimPaths: Type.Array(nonEmpty, { maxItems: 20, uniqueItems: true }),
	explanation: nonEmpty,
}, { additionalProperties: false });

const submissionSchemas = {
	requirements: jobRequirement,
	resume_draft: Type.Object({ analysis, resumePlan, verification }, { additionalProperties: false }),
	verification,
	facts_review: Type.Object(baseReview, { additionalProperties: false }),
	quality_review: Type.Object({
		...baseReview,
		coverage: Type.Array(coverage, { maxItems: 20 }),
		// Evidence may be empty: excluding a requirement for lack of any master-resume
		// support is an absence claim, and there is no source ID to cite for an absence.
		alternatives: Type.Array(Type.Object({ evidence: optionalEvidence, reason: nonEmpty }, { additionalProperties: false }), { maxItems: 20 }),
	}, { additionalProperties: false }),
	cover_letter: Type.Object({ text: Type.String({ minLength: 1, maxLength: 20000 }) }, { additionalProperties: false }),
	cover_letter_review: Type.Object({
		approved: Type.Boolean(),
		issues: Type.Array(Type.Object({ claim: nonEmpty, reason: nonEmpty, suggestion: nonEmpty }, { additionalProperties: false }), { maxItems: 20 }),
		summary: nonEmpty,
		wordCount: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false }),
} as const;

/**
 * The agent runtime validates tool-call arguments against `tool.parameters`
 * with its own compiled TypeBox/AJV-style checker BEFORE our tool's execute()
 * ever runs (see `@earendil-works/pi-ai`'s `validateToolArguments`). That
 * layer has no JSON-string-to-object coercion, so a provider that
 * double-serializes a nested object (`resumePlan: "{...}"`) gets rejected
 * with an opaque "must be object" error and our tool body — including
 * `coerceJsonStrings` below — never gets a chance to run.
 *
 * To fix this at its actual layer, the *exposed* schema for each top-level
 * object/array property also accepts a raw JSON string, so the runtime's
 * pre-execute check passes through a double-serialized argument instead of
 * rejecting it outright. `validateWorkerSubmission` then re-validates the
 * (coerced) value against the real, strict `submissionSchemas` below, so no
 * actual leniency is introduced into the semantic contract.
 */
function toolFacingSchema(strict: unknown): unknown {
	const node = strict as { properties: Record<string, { type?: string }> };
	const properties: Record<string, any> = {};
	for (const [key, propSchema] of Object.entries(node.properties)) {
		properties[key] = propSchema.type === "object" || propSchema.type === "array"
			? Type.Union([propSchema as any, Type.String({ minLength: 1, maxLength: 100_000 })])
			: propSchema;
	}
	return Type.Object(properties, { additionalProperties: false });
}
const toolParameterSchemas = Object.fromEntries(
	(Object.keys(submissionSchemas) as WorkerSubmissionKind[]).map((kind) => [kind, toolFacingSchema(submissionSchemas[kind])]),
) as Record<WorkerSubmissionKind, unknown>;

const toolNames: Record<WorkerSubmissionKind, string> = {
	requirements: "submit_requirements",
	resume_draft: "submit_resume_draft",
	verification: "submit_verification",
	facts_review: "submit_factual_review",
	quality_review: "submit_quality_review",
	cover_letter: "submit_cover_letter",
	cover_letter_review: "submit_cover_letter_review",
};

const submissionShapes: Record<WorkerSubmissionKind, string> = {
	requirements: "{ schemaVersion: 1, job: { company: string, role: string, roleQuote: string }, summary: { text: string, quotes: string[] }, details: [{ label: string, text: string, quote: string }], requirements: [{ id: string, text: string, quote: string, importance: \"core\" | \"supporting\" | \"optional\" }], skills: [{ name: string, quote: string, importance: \"core\" | \"supporting\" | \"optional\" }], responsibilities: [{ text: string, quote: string }] }",
	resume_draft: "{ analysis: JobAnalysis, resumePlan: { schemaVersion: 2, target: {...}, header: {...}, education: {...}, skills: [...], workExperience: [{ title, dates, subtitle, location, bullets: [{text,evidence}] (2-3), evidence }] (3-5 entries, NOT projects), projects: [{ title, dates?, bullets: [{text,evidence}] (exactly 1), evidence }] (0-2 entries) }, verification: { approved: boolean, issues: [{ claim: string, reason: string }], summary: string } }. resumePlan is a JSON OBJECT, never a JSON-encoded string. There is no sections/title/kind field: work entries always belong to workExperience and standalone projects always belong to projects.",
	verification: "{ approved: boolean, issues: [{ claim: string, reason: string }], summary: string }",
	facts_review: "{ approved: boolean, issues: [{ claim: string, reason: string, evidence: string[], suggestion: string }], summary: string }",
	quality_review: "{ approved: boolean, issues: [{ claim: string, reason: string, evidence: string[], suggestion: string }], summary: string, coverage: [{ requirementId: string, status: \"supported\" | \"unsupported_but_real\" | \"irrelevant\", evidence: string[], claimPaths: string[], explanation: string }], alternatives: [{ evidence: string[], reason: string }] }",
	cover_letter: "{ text: string }",
	cover_letter_review: "{ approved: boolean, issues: [{ claim: string, reason: string, suggestion: string }], summary: string, wordCount: integer }",
};

export function submissionToolName(kind: WorkerSubmissionKind): string {
	return toolNames[kind];
}

/** Repeated verbatim in every worker context so a JSON chat reply cannot be mistaken for a submission. */
export function workerSubmissionProtocol(kind: WorkerSubmissionKind): string {
	const name = submissionToolName(kind);
	return `\n\nCompletion protocol (mandatory):\n- Do not put the completed artifact in a chat message, Markdown fence, prose response, or file. Chat output is ignored by the coordinator.\n- Your final action in this conversation must be exactly one call to the \`${name}\` tool.\n- Pass one argument object that matches the tool's schema exactly: \`${submissionShapes[kind]}\`. Use the tool's displayed schema for all nested fields and limits.\n- If the tool reports a validation error, fix only that error and call \`${name}\` again. Do not end the conversation until the tool accepts the submission.\n- After the accepted \`${name}\` call, stop; the coordinator persists the artifact.`;
}

const MAX_WORKER_READ_BYTES = 1024 * 1024;

export type SubmissionContext = {
	folder: string;
	workspace: ApplyJobWorkspace;
	company: string;
	role: string;
	minCoverLetterWords?: number;
	maxCoverLetterWords?: number;
	/** Only enforced for resume_draft: a drafter may never move or reword a locked entry. */
	lockedEntries?: Array<ResumePlan["workExperience"][number] | ResumePlan["projects"][number]>;
};
export type ResumeDraftSubmission = { analysis: JobAnalysis; resumePlan: ResumePlan; verification: VerificationResult };

/** A resume plan has exactly two entry collections; callers that only care about entries (not which heading they render under) can use this. */
export function planEntries(plan: ResumePlan): Array<ResumePlan["workExperience"][number] | ResumePlan["projects"][number]> {
	return [...plan.workExperience, ...plan.projects];
}

function workerReadPaths(kind: WorkerSubmissionKind, context: SubmissionContext): string[] {
	const inJob = (...names: string[]) => names.map(name => path.join(context.folder, name));
	const masterResume = path.join(context.workspace.masterDir, "resume.md");
	if (kind === "requirements") return inJob("job.md");
	if (kind === "facts_review") return inJob(".review-packet-facts.json");
	if (kind === "quality_review") return inJob(".review-packet-quality.json");
	if (kind === "verification") return [masterResume, ...inJob("resume-plan.json", "resume.md", "verification.json", "claim-ledger.json")];
	if (kind === "cover_letter" || kind === "cover_letter_review") {
		return [
			masterResume,
		...inJob("job-requirement.json", "cover-letter.md", "cover-letter-review.json"),
			...(context.workspace.coverLetterDir ? coverLetterSources(context.workspace.coverLetterDir) : []),
		];
	}
	return [
		masterResume,
		path.join(context.workspace.templateDir, "resume-template.tex"),
		...inJob("job-requirement.json", "resume-plan.json", "resume.md", "verification.json", "independent-verification.json", "quality-review.json", "layout.json", "claim-ledger.json"),
	];
}

function coverLetterSources(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];
	const output: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) output.push(...coverLetterSources(entryPath));
		else if (entry.isFile() && [".md", ".txt"].includes(path.extname(entry.name).toLowerCase())) output.push(entryPath);
	}
	return output;
}

/** Read access is allowlisted per worker role; job text cannot make a worker explore unrelated files. */
export function createWorkerReadTool(kind: WorkerSubmissionKind, context: SubmissionContext): ToolDefinition {
	const allowed = new Set(workerReadPaths(kind, context)
		.filter(file => fs.existsSync(file) && fs.statSync(file).isFile())
		.map(file => fs.realpathSync(file)));
	return defineTool({
		name: "read_pipeline_file",
		label: "read_pipeline_file",
		description: "Read one coordinator-assigned text artifact. Other filesystem paths are rejected.",
		promptSnippet: "Read an assigned pipeline input",
		promptGuidelines: ["Use only paths explicitly assigned in the workflow prompt."],
		parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			let requested: string;
			try { requested = fs.realpathSync(path.resolve(params.path)); }
			catch { throw new Error("Assigned pipeline file does not exist"); }
			if (!allowed.has(requested)) throw new Error("Path is outside this worker's assigned read set");
			const stat = fs.statSync(requested);
			if (!stat.isFile() || stat.size > MAX_WORKER_READ_BYTES) throw new Error(`Assigned pipeline file must be a regular text file no larger than ${MAX_WORKER_READ_BYTES} bytes`);
			return { content: [{ type: "text" as const, text: fs.readFileSync(requested, "utf8") }], details: { path: requested } };
		},
	}) as ToolDefinition;
}

function validVerification(value: unknown): VerificationResult {
	const result = value as VerificationResult;
	if (result.approved !== (result.issues.length === 0)) throw new Error("approved must be true exactly when issues is empty");
	return result;
}

function wordCount(value: string): number { return value.trim().split(/\s+/).filter(Boolean).length; }

/**
 * Some providers double-serialize a nested object argument as a JSON string
 * (e.g. `resumePlan: "{\"schemaVersion\":2,...}"`). This is unambiguous model
 * error, not a semantic ambiguity, so fix it up before validation instead of
 * rejecting a submission whose intent is completely clear. Real schema
 * violations still fail Check() below with a precise field-level error.
 */
/**
 * Some providers wrap a stringified object in a Markdown code fence
 * (```json ... ```) instead of raw JSON text. Strip that before parsing;
 * this is purely a syntactic cleanup, never a semantic relaxation.
 */
function parseJsonLoosely(raw: string): unknown {
	try { return JSON.parse(raw); } catch { /* fall through to fence-stripping */ }
	const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
	if (unfenced === raw.trim()) throw new Error("not valid JSON");
	return JSON.parse(unfenced);
}
function coerceJsonStrings(schema: unknown, value: unknown, path = ""): unknown {
	const node = schema as { type?: string; properties?: Record<string, unknown>; items?: unknown };
	if (typeof value === "string" && (node?.type === "object" || node?.type === "array")) {
		let parsed: unknown;
		try {
			parsed = parseJsonLoosely(value);
		} catch (e) {
			// A malformed (e.g. truncated or unescaped) stringified object is
			// unambiguously a model mistake, but "must be object" alone gives it
			// nothing to correct. Name the field and the concrete JSON syntax
			// error so a retry can actually fix it instead of resubmitting the
			// same broken string.
			const reason = e instanceof Error ? e.message : String(e);
			const preview = value.length > 160 ? `${value.slice(0, 160)}…` : value;
			throw new Error(`${path || "value"} was submitted as a JSON-encoded string but failed to parse as JSON (${reason}). Submit ${path || "this field"} as a native JSON object/array argument, not a string. Received: ${JSON.stringify(preview)}`);
		}
		return coerceJsonStrings(schema, parsed, path);
	}
	if (Array.isArray(value) && node?.type === "array" && node.items) {
		return value.map((item, index) => coerceJsonStrings(node.items, item, `${path}[${index}]`));
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || node?.type !== "object" || !node.properties) return value;
	const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
	for (const [key, propSchema] of Object.entries(node.properties)) {
		if (key in result) result[key] = coerceJsonStrings(propSchema, result[key], path ? `${path}.${key}` : key);
	}
	return result;
}

/** Semantic validation runs inside the submission tool and returns errors to the same worker turn. */
export function validateWorkerSubmission(kind: WorkerSubmissionKind, rawValue: unknown, context: SubmissionContext): unknown {
	const schema = submissionSchemas[kind] as any;
	const value = coerceJsonStrings(schema, rawValue);
	if (!Check(schema, value)) {
		const first = Errors(schema, value)[0];
		throw new Error(`Invalid ${kind} submission at ${first?.instancePath || "/"}: ${first?.message || "schema mismatch"}`);
	}
	const master = () => readTextFile(path.join(context.workspace.masterDir, "resume.md"));
	if (kind === "requirements") return validateJobRequirement(value, readTextFile(path.join(context.folder, "job.md")));
	if (kind === "resume_draft") {
		const result = value as ResumeDraftSubmission;
		if (result.resumePlan.target.company !== context.company || result.resumePlan.target.role !== context.role) throw new Error("resumePlan.target must exactly match the assigned company and role");
		renderPlan(result.resumePlan);
		const masterText = master();
		buildLedger(result.resumePlan, masterText);
		const known = sourceInventory(masterText);
		const unknownAnalysisEvidence = result.analysis.implicitSkills.flatMap(item => item.evidence).find(id => !known.has(id));
		if (unknownAnalysisEvidence) throw new Error(`analysis cites unknown master-resume evidence ID: ${unknownAnalysisEvidence}`);
		validVerification(result.verification);
		if (context.lockedEntries?.length) {
			const entries = planEntries(result.resumePlan);
			for (const locked of context.lockedEntries) {
				if (!entries.some(entry => JSON.stringify(entry) === JSON.stringify(locked))) throw new Error(`Drafter changed locked entry: ${locked.title}`);
			}
		}
		return result;
	}
	if (kind === "verification") return validVerification(value);
	if (kind === "facts_review" || kind === "quality_review") {
		const plan = readJsonFile<ResumePlan>(path.join(context.folder, "resume-plan.json"));
		const ledger = reviewLedger(buildLedger(plan, master()), master());
		const requirements = kind === "quality_review"
			? validateJobRequirement(readJsonFile(path.join(context.folder, "job-requirement.json")), readTextFile(path.join(context.folder, "job.md"))).requirements
			: undefined;
		return validateReview(value, ledger, requirements);
	}
	if (kind === "cover_letter") {
		const result = value as { text: string };
		const count = wordCount(result.text);
		const minimum = context.minCoverLetterWords ?? 250;
		const maximum = context.maxCoverLetterWords ?? 425;
		if (count < minimum || count > maximum) throw new Error(`cover letter has ${count} words; required range is ${minimum}–${maximum}`);
		return result;
	}
	const result = value as CoverLetterReview;
	if (result.approved !== (result.issues.length === 0)) throw new Error("cover-letter approval must agree with its issues array");
	const actual = wordCount(readTextFile(path.join(context.folder, "cover-letter.md")));
	if (result.wordCount !== actual) throw new Error(`wordCount must equal the deterministic count ${actual}`);
	return result;
}

export function createWorkerSubmissionTool(kind: WorkerSubmissionKind, context: SubmissionContext): {
	tool: ToolDefinition;
	consume(): unknown;
} {
	let submission: unknown;
	const name = submissionToolName(kind);
	const tool = defineTool({
		name,
		label: name,
		description: "Submit the completed artifact. Invalid schema or semantic content is rejected immediately; correct the arguments and call this tool again.",
		promptSnippet: `Submit the completed artifact with ${name}`,
		promptGuidelines: [`Use ${name} as the final action. You cannot write or edit files directly.`],
		// Loosened only so the runtime's pre-execute check tolerates a
		// double-serialized nested field; validateWorkerSubmission below
		// still enforces the real, strict schema on every submission.
		parameters: toolParameterSchemas[kind] as any,
		async execute(_toolCallId, params) {
			const value = validateWorkerSubmission(kind, params, context);
			// Measured PDF layout is deterministic and cheap (a LaTeX compile),
			// while the independent facts/quality reviewers are expensive LLM
			// calls. Check layout here, immediately on submission and inside the
			// same worker turn, so a layout defect is fixed before either
			// reviewer ever runs on content that would just get discarded.
			if (kind === "resume_draft") {
				const draft = value as ResumeDraftSubmission;
				persistResumeDraft(context.folder, draft);
				if (draft.verification.approved) {
					const rendered = await renderResume(context.workspace, context.folder);
					if (!rendered.passed) {
						throw new Error(`Measured PDF layout findings: ${rendered.warnings.join("; ")}. Correct only what these findings require, then call ${name} again.`);
					}
				}
			}
			submission = value;
			return { content: [{ type: "text" as const, text: "Validated submission accepted by the coordinator." }], details: { kind }, terminate: true };
		},
	}) as ToolDefinition;
	return {
		tool,
		consume() {
			if (submission === undefined) throw new Error(`Worker stopped without calling ${name}`);
			const value = submission;
			submission = undefined;
			return value;
		},
	};
}

function renderAnalysisMarkdown(value: JobAnalysis): string {
	const list = (title: string, values: string[]) => `## ${title}\n\n${values.length ? values.map(item => `- ${item}`).join("\n") : "- None"}`;
	return [
		"# Resume analysis",
		`\n**Fit score:** ${value.fitScore}/10`,
		list("Strengths", value.strengths),
		list("Weaknesses", value.weaknesses),
		list("Explicit matches", value.explicitMatches),
		`## Implicit skills\n\n${value.implicitSkills.length ? value.implicitSkills.map(item => `- ${item.skill} — ${item.evidence.join(", ")}`).join("\n") : "- None"}`,
		list("Missing requirements", value.missingRequirements),
		list("Resume recommendations", value.resumeRecommendations),
	].join("\n\n") + "\n";
}

/** Preview is derived from the validated plan, so it cannot drift from it. */
function renderResumeMarkdown(plan: ResumePlan): string {
	const lines = [`# ${plan.header.name}${plan.header.headline ? ` — ${plan.header.headline}` : ""}`, plan.header.contactLine, "", "## Education", `${plan.education.institution} — ${plan.education.dates}`, `${plan.education.degree}${plan.education.gpa ? ` — GPA: ${plan.education.gpa}` : ""} — ${plan.education.location}`];
	if (plan.education.honors.items.length) lines.push(`- Honors / Awards: ${plan.education.honors.items.join(", ")}`);
	if (plan.education.coursework.items.length) lines.push(`- Coursework: ${plan.education.coursework.items.join(", ")}`);
	lines.push("", "## Technical Skills", ...plan.skills.map(skill => `- ${skill.label}: ${skill.value}`));
	lines.push("", "## Work Experience");
	for (const item of plan.workExperience) {
		lines.push(`### ${item.title}${item.dates ? ` — ${item.dates}` : ""}`, [item.subtitle, item.location].filter(Boolean).join(" — "), ...item.bullets.map(point => `- ${point.text}`));
	}
	if (plan.projects.length) {
		lines.push("", "## Projects");
		for (const item of plan.projects) {
			lines.push(`### ${item.title}${item.dates ? ` — ${item.dates}` : ""}`, ...item.bullets.map(point => `- ${point.text}`));
		}
	}
	return lines.filter((line, index) => line || lines[index - 1] !== "").join("\n").trim() + "\n";
}

/** Only coordinator code calls this after the submission tool accepted the payload. */
export function persistResumeDraft(folder: string, result: ResumeDraftSubmission): JobAnalysis {
	writeTextFile(path.join(folder, "analysis.md"), renderAnalysisMarkdown(result.analysis));
	writeJsonFile(path.join(folder, "resume-plan.json"), result.resumePlan);
	writeTextFile(path.join(folder, "resume.md"), renderResumeMarkdown(result.resumePlan));
	writeJsonFile(path.join(folder, "verification.json"), result.verification);
	return result.analysis;
}
