/** Typed worker submissions. Workers never receive a filesystem mutation tool. */

import path from "node:path";
import fs from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { buildLedger, factualAuditLedger, reviewLedger, sourceInventory, validateFactualReview, validateJobRequirement } from "./evidence.js";
import { renderPlan, renderResume } from "./render-resume.js";
import type { CoverLetterReview, ResumePlan, ResumePlanInput } from "./schemas.js";
import { readJsonFile, readTextFile, writeJsonFile, writeTextFile, type ApplyJobWorkspace } from "./utils.js";

export type WorkerSubmissionKind =
	| "requirements"
	| "resume_draft"
	| "facts_review"
	| "targeted_patch"
	| "cover_letter"
	| "cover_letter_review";

const nonEmpty = Type.String({ minLength: 1, maxLength: 4000 });
const evidence = Type.Array(nonEmpty, { minItems: 1, maxItems: 16, uniqueItems: true });
const optionalEvidence = Type.Array(nonEmpty, { maxItems: 16, uniqueItems: true });
const factualIssue = Type.Object({ path: nonEmpty, clause: nonEmpty, reason: nonEmpty, evidence }, { additionalProperties: false });
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
const bullet = Type.Object({ text: nonEmpty, evidence }, { additionalProperties: false });
const coursework = Type.Object({ items: Type.Array(nonEmpty, { maxItems: 8 }), evidence: optionalEvidence }, { additionalProperties: false });
const selectedWorkEntry = Type.Object({ id: nonEmpty, bullets: Type.Array(bullet, { minItems: 2, maxItems: 3 }) }, { additionalProperties: false });
const selectedProjectEntry = Type.Object({ id: nonEmpty, bullets: Type.Array(bullet, { minItems: 1, maxItems: 1 }) }, { additionalProperties: false });
const resumePlan = Type.Object({
	coursework,
	skills: Type.Array(Type.Object({ label: nonEmpty, value: nonEmpty, evidence }, { additionalProperties: false }), { minItems: 2, maxItems: 3 }),
	workExperience: Type.Array(selectedWorkEntry, { minItems: 3, maxItems: 5 }),
	projects: Type.Array(selectedProjectEntry, { minItems: 0, maxItems: 2 }),
}, { additionalProperties: false });
const baseReview = {
	approved: Type.Boolean(),
	issues: Type.Array(factualIssue, { maxItems: 20 }),
	summary: nonEmpty,
};
const targetedPatch = Type.Object({
	targetPath: nonEmpty,
	replacement: nonEmpty,
	evidence,
}, { additionalProperties: false });

const submissionSchemas = {
	requirements: jobRequirement,
	resume_draft: resumePlan,
	facts_review: Type.Object(baseReview, { additionalProperties: false }),
	targeted_patch: Type.Object({ patches: Type.Array(targetedPatch, { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
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
 * double-serializes a nested object or array (`coursework: "{...}"`) gets rejected
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
	facts_review: "submit_factual_review",
	targeted_patch: "submit_targeted_patch",
	cover_letter: "submit_cover_letter",
	cover_letter_review: "submit_cover_letter_review",
};

const submissionShapes: Record<WorkerSubmissionKind, string> = {
	requirements: "{ schemaVersion: 1, job: { company: string, role: string, roleQuote: string }, summary: { text: string, quotes: string[] }, details: [{ label: string, text: string, quote: string }], requirements: [{ id: string, text: string, quote: string, importance: \"core\" | \"supporting\" | \"optional\" }], skills: [{ name: string, quote: string, importance: \"core\" | \"supporting\" | \"optional\" }], responsibilities: [{ text: string, quote: string }] }",
	resume_draft: "{ coursework: { items: string[] (0-8 completed courses), evidence: string[] }, skills: [...], workExperience: [{ id: string, bullets: [{text,evidence}] (2-3) }] (3-5 entries), projects: [{ id: string, bullets: [{text,evidence}] (exactly 1) }] (0-2 entries) }. Submit this plan object directly, never as a JSON-encoded string and never inside a resumePlan wrapper. Each work/project id must be the stable master-resume ID for its heading. The coordinator derives the fixed header, institution, degree, GPA, honors, and each selected entry's title, dates, subtitle, and location from the master resume. There is no analysis, verification, schemaVersion, target, header, education, sections, title, kind, dates, subtitle, location, or entry-level evidence field to submit.",
	facts_review: "{ approved: boolean, issues: [{ path: string, clause: string, reason: string, evidence: string[] }], summary: string }",
	targeted_patch: "{ patches: [{ targetPath: string, replacement: string, evidence: string[] }] }. Every targetPath must be on the coordinator's allowlist; do not submit any other plan field.",
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
export type TargetedPatchSubmission = { patches: Array<{ targetPath: string; replacement: string; evidence: string[] }> };

/** A resume plan has exactly two entry collections; callers that only care about entries (not which heading they render under) can use this. */
export function planEntries(plan: ResumePlan): Array<ResumePlan["workExperience"][number] | ResumePlan["projects"][number]> {
	return [...plan.workExperience, ...plan.projects];
}

function workerReadPaths(kind: WorkerSubmissionKind, context: SubmissionContext): string[] {
	const inJob = (...names: string[]) => names.map(name => path.join(context.folder, name));
	const masterResume = path.join(context.workspace.masterDir, "resume.md");
	if (kind === "requirements") return inJob("job.md");
	if (kind === "facts_review") return inJob(".review-packet-facts.json");
	if (kind === "targeted_patch") return [masterResume, ...inJob("resume-plan.json", "independent-verification.json", "claim-ledger.json", "layout.json")];
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
		...inJob("job-requirement.json", "resume-plan.json", "resume.md", "independent-verification.json", "layout.json", "claim-ledger.json"),
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

function wordCount(value: string): number { return value.trim().split(/\s+/).filter(Boolean).length; }

/**
 * Header and fixed education values are candidate-owned facts, not drafting
 * choices. Read them once from the canonical master before rendering or
 * auditing a worker's variable content selection.
 */
function materializeResumePlan(input: ResumePlanInput, master: string): ResumePlan {
	const fail = (field: string): never => { throw new Error(`Master resume is missing the fixed ${field} required to build a resume plan`); };
	const educationStart = master.search(/^## Education\s*$/m);
	if (educationStart < 0) fail("Education section");
	const headerBlock = master.slice(0, educationStart);
	const title = headerBlock.match(/^#\s+\[([^\]]+)\]\s+(.+)$/m);
	if (!title) throw new Error("Master resume is missing the fixed header name required to build a resume plan");
	const titleId = title[1]!;
	const name = title[2]!.split(" — ")[0].trim();
	const afterTitle = headerBlock.slice((title.index ?? 0) + title[0].length);
	const firstContact = afterTitle.search(/^[-*]\s+\[identity-[^\]]+\]/m);
	const headlineCandidates = afterTitle.slice(0, firstContact < 0 ? undefined : firstContact)
		.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
	const headline = headlineCandidates.at(-1);
	if (!headline) throw new Error("Master resume is missing the fixed header headline required to build a resume plan");
	const contacts = [...headerBlock.matchAll(/^[-*]\s+\[(identity-[^\]]+)\]\s+(.+)$/gm)];
	if (!contacts.length) fail("header contact line");

	const afterEducationHeading = master.slice(educationStart).replace(/^## Education\s*\n/, "");
	const nextSection = afterEducationHeading.search(/^##\s/m);
	const educationBlock = nextSection < 0 ? afterEducationHeading : afterEducationHeading.slice(0, nextSection);
	if (!educationBlock.trim()) fail("Education section");
	const educationHeading = educationBlock.match(/^###\s+\[([^\]]+)\]\s+(.+?)\s+—\s+(.+)$/m);
	if (!educationHeading) throw new Error("Master resume is missing the fixed education institution and location required to build a resume plan");
	const educationId = educationHeading[1]!;
	const institution = educationHeading[2]!;
	const location = educationHeading[3]!;
	const afterHeading = educationBlock.slice((educationHeading.index ?? 0) + educationHeading[0].length);
	const fixedLines = afterHeading.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("-"));
	const [degreeLine, dates] = fixedLines;
	if (!degreeLine || !dates) fail("education degree and dates");
	const gpaMatch = degreeLine.match(/,\s*GPA:\s*(.+)$/i);
	const honor = educationBlock.match(/^[-*]\s+\[([^\]]+)\]\s+Honors\s*\/\s*Awards:\s*(.+)$/m);
	if (!honor) throw new Error("Master resume is missing the fixed education honors required to build a resume plan");
	const honorId = honor[1]!;
	const honorItems = honor[2]!;
	const known = sourceInventory(master);
	const evidenceIds = [titleId, ...contacts.map(contact => contact[1]!), educationId, honorId];
	if (evidenceIds.some(id => !known.has(id))) fail("evidence IDs");
	return {
		header: { name, headline, contactLine: contacts.map(contact => contact[2]!).join(" | "), evidence: [titleId, ...contacts.map(contact => contact[1]!)] },
		education: {
			institution: institution.trim(),
			degree: degreeLine.replace(/,\s*GPA:\s*.+$/i, "").trim(),
			gpa: gpaMatch?.[1].trim() ?? "",
			dates,
			location: location.trim(),
			evidence: [educationId],
			honors: { items: honorItems.split(/,\s*/).map(item => item.trim()).filter(Boolean), evidence: [honorId] },
			coursework: input.coursework,
		},
		skills: input.skills,
		workExperience: input.workExperience.map(entry => ({ ...fixedWorkExperience(entry.id, master, known), bullets: entry.bullets, evidence: [entry.id] })),
		projects: input.projects.map(entry => ({ ...fixedProject(entry.id, master, known), bullets: entry.bullets, evidence: [entry.id] })),
	};
}

function masterSection(master: string, heading: string): string {
	const start = master.search(new RegExp(`^## ${heading}\\s*$`, "m"));
	if (start < 0) throw new Error(`Master resume is missing its ${heading} section`);
	const afterHeading = master.slice(start).replace(new RegExp(`^## ${heading}\\s*\\n`), "");
	const nextSection = afterHeading.search(/^##\s/m);
	return nextSection < 0 ? afterHeading : afterHeading.slice(0, nextSection);
}

function sourceForEntry(id: string, section: string, master: string, sources: ReturnType<typeof sourceInventory>) {
	if (!masterSection(master, section).includes(`### [${id}]`)) {
		throw new Error(`${id} is not a ${section === "Work Experience" ? "work-experience" : "project"} heading ID in the master resume`);
	}
	const source = sources.get(id);
	if (!source) throw new Error(`Unknown master-resume evidence ID: ${id}`);
	return source;
}

function fixedWorkExperience(id: string, master: string, sources: ReturnType<typeof sourceInventory>): Omit<ResumePlan["workExperience"][number], "bullets" | "evidence"> {
	const source = sourceForEntry(id, "Work Experience", master, sources);
	const lines = source.text.split("\n").map(line => line.trim()).filter(Boolean);
	const heading = lines[0]?.replace(/^###\s+\[[^\]]+\]\s+/, "");
	const details = lines.slice(1).find(line => !line.startsWith("-"));
	if (!heading || !details) throw new Error(`Master work entry ${id} must include a heading and location/date line`);
	const titleParts = heading.split(" — ");
	const atMatch = titleParts.length === 1 ? heading.match(/^(.*?)\s+at\s+(.+)$/) : undefined;
	const title = titleParts.length > 1 ? titleParts[0] : atMatch?.[1];
	const subtitle = titleParts.length > 1 ? titleParts.slice(1).join(" — ") : atMatch?.[2];
	const detailParts = details.split(" | ");
	if (!title || !subtitle || detailParts.length !== 2) throw new Error(`Master work entry ${id} must use “Title — Employer” and “Location | Dates”`);
	const looksLikeDate = (value: string) => /\b(?:19|20)\d{2}\b|\bPresent\b/i.test(value);
	const [first, second] = detailParts;
	const dates = looksLikeDate(first) ? first : second;
	const location = looksLikeDate(first) ? second : first;
	if (!dates || !location) throw new Error(`Master work entry ${id} must include non-empty dates and location`);
	return { title, subtitle, dates, location };
}

function fixedProject(id: string, master: string, sources: ReturnType<typeof sourceInventory>): Omit<ResumePlan["projects"][number], "bullets" | "evidence"> {
	const source = sourceForEntry(id, "Projects", master, sources);
	const lines = source.text.split("\n").map(line => line.trim()).filter(Boolean);
	const title = lines[0]?.replace(/^###\s+\[[^\]]+\]\s+/, "");
	const dates = lines.slice(1).find(line => !line.startsWith("-"));
	if (!title || !dates) throw new Error(`Master project ${id} must include a title and date line`);
	return { title, dates };
}

/**
 * Some providers double-serialize an object or array argument as a JSON string,
 * or wrap it in a Markdown fence. That is a model formatting mistake, not a
 * semantic ambiguity, so coerce it before the strict schema check.
 */
function parseJsonLoosely(raw: string): unknown {
	try { return JSON.parse(raw); } catch (first) {
		const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
		if (unfenced === raw.trim()) throw first;
		return JSON.parse(unfenced);
	}
}
function formatToolArguments(value: unknown): string {
	try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function coerceJsonStrings(schema: unknown, value: unknown, path = "", root?: unknown): unknown {
	const node = schema as { type?: string; properties?: Record<string, unknown>; items?: unknown };
	const call = root !== undefined ? root : value;
	if (typeof value === "string" && (node?.type === "object" || node?.type === "array")) {
		let parsed: unknown;
		try {
			parsed = parseJsonLoosely(value);
		} catch (e) {
			// A malformed (e.g. truncated or unescaped) stringified object is
			// unambiguously a model mistake, but "must be object" alone gives it
			// nothing to correct. Name the field, keep the parser's syntax error,
			// and dump the entire tool arguments so a retry can actually fix it.
			const reason = e instanceof Error ? e.message : String(e);
			throw new Error(`${path || "value"} was submitted as a JSON-encoded string but failed to parse as JSON (${reason}). Submit ${path || "this field"} as a native JSON object/array argument, not a string.\nBroken field ${path || "value"}:\n${value}\nFull tool arguments:\n${formatToolArguments(call)}`);
		}
		return coerceJsonStrings(schema, parsed, path, call);
	}
	if (Array.isArray(value) && node?.type === "array" && node.items) {
		return value.map((item, index) => coerceJsonStrings(node.items, item, `${path}[${index}]`, call));
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || node?.type !== "object" || !node.properties) return value;
	const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
	for (const [key, propSchema] of Object.entries(node.properties)) {
		if (key in result) result[key] = coerceJsonStrings(propSchema, result[key], path ? `${path}.${key}` : key, call);
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
		const submitted = value as ResumePlanInput;
		const masterText = master();
		const result = materializeResumePlan(submitted, masterText);
		renderPlan(result);
		buildLedger(result, masterText);
		if (context.lockedEntries?.length) {
			const entries = planEntries(result);
			for (const locked of context.lockedEntries) {
				if (!entries.some(entry => JSON.stringify(entry) === JSON.stringify(locked))) throw new Error(`Drafter changed locked entry: ${locked.title}`);
			}
		}
		return result;
	}
	if (kind === "facts_review") {
		const plan = readJsonFile<ResumePlan>(path.join(context.folder, "resume-plan.json"));
		const ledger = factualAuditLedger(reviewLedger(buildLedger(plan, master()), master()));
		return validateFactualReview(value, ledger);
	}
	if (kind === "targeted_patch") return value as TargetedPatchSubmission;
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
			if (kind === "resume_draft") {
				const draft = value as ResumePlan;
				const master = readTextFile(path.join(context.workspace.masterDir, "resume.md"));
				persistResumeDraft(context.folder, draft, master);
				const rendered = await renderResume(context.workspace, context.folder);
				if (!rendered.passed) {
					throw new Error(`Measured PDF layout findings: ${rendered.warnings.join("; ")}. Correct only what these findings require, then call ${name} again.`);
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
export function persistResumeDraft(folder: string, result: ResumePlan, master: string): void {
	writeJsonFile(path.join(folder, "resume-plan.json"), result);
	writeTextFile(path.join(folder, "resume.md"), renderResumeMarkdown(result));
	writeJsonFile(path.join(folder, "claim-ledger.json"), buildLedger(result, master));
}
