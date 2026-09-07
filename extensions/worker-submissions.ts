/** Typed worker submissions. Workers never receive a filesystem mutation tool. */

import path from "node:path";
import fs from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { buildLedger, editablePath, factualAuditLedger, reviewLedger, sourceInventory, validateFactualReview, validateJobRequirement } from "./evidence.js";
import { renderPlan, renderResume } from "./render-resume.js";
import { isResumePlan, type CoverLetterReview, type ResumePlan, type ResumePlanInput } from "./schemas.js";
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
	skills: Type.Array(Type.Object({ label: nonEmpty, value: nonEmpty, evidence }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
	workExperience: Type.Array(selectedWorkEntry, { minItems: 3, maxItems: 4 }),
	projects: Type.Array(selectedProjectEntry, { minItems: 1, maxItems: 2 }),
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
	resume_draft: "{ coursework: { items: string[] filling exactly 2 PDF lines, evidence: string[] }, skills: 1–3 categories occupying at most 3 PDF lines, workExperience: 3 entries at 3/3/2 bullets or 4 entries at 3/3/2/2, projects: 2 entries (with 3 work) or 1 entry (with 4 work), each with exactly 1 bullet }. Submit this plan object directly, never as a JSON-encoded string or a value nested under a resumePlan wrapper. workExperience[0] and [1] have 3 bullets (2 PDF lines each); [2] has 2 bullets (2 PDF lines each); optional [3] has 2 bullets totaling 3 PDF lines. Each project bullet occupies 2–3 PDF lines. Each work/project id must be the stable master-resume ID for its heading. The coordinator derives the fixed header, institution, degree, GPA, honors, and each selected entry's title, dates, subtitle, and location from the master resume. There is no analysis, verification, schemaVersion, target, header, education, sections, title, kind, dates, subtitle, location, or entry-level evidence field to submit.",
	facts_review: "{ approved: boolean, issues: [{ path: string, clause: string, reason: string, evidence: string[] }], summary: string }",
	targeted_patch: "{ patches: [{ targetPath: string, replacement: string, evidence: string[] }] }. Every targetPath must be on the coordinator's allowlist; do not submit any other plan field.",
	cover_letter: "{ text: string }",
	cover_letter_review: "{ approved: boolean, issues: [{ claim: string, reason: string, suggestion: string }], summary: string, wordCount: integer }",
};

export function submissionToolName(kind: WorkerSubmissionKind): string {
	return toolNames[kind];
}

export function workerReadToolName(kind: WorkerSubmissionKind): string {
	if (kind === "resume_draft") return "read_draft_source";
	if (kind === "facts_review") return "read_facts_packet";
	if (kind === "targeted_patch") return "read_editor_packet";
	if (kind === "requirements") return "read_job_posting";
	return "read_pipeline_file";
}

/** Repeated verbatim in every worker context so a JSON chat reply cannot be mistaken for a submission. */
export function workerSubmissionProtocol(kind: WorkerSubmissionKind): string {
	const name = submissionToolName(kind);
	const readName = workerReadToolName(kind);
	const readRetry = readName === "read_pipeline_file"
		? "- If read_pipeline_file fails, retry only with a path named in that tool's description; never search or guess filenames.\n"
		: `- Read assigned sources with \`${readName}\`.\n`;
	return `\n\nCompletion protocol (mandatory):\n- Do not put the completed artifact in a chat message, Markdown fence, or prose response. Chat output is ignored by the coordinator.\n- Your final action in this conversation must be exactly one call to the \`${name}\` tool.\n- Pass one argument object that matches the tool's schema exactly: \`${submissionShapes[kind]}\`. Use the tool's displayed schema for all nested fields and limits.\n- If the tool reports a validation error, fix only that error and call \`${name}\` again. Do not end the conversation until the tool accepts the submission.\n${readRetry}- After the accepted \`${name}\` call, stop; the coordinator persists the artifact.`;
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
	/** Only enforced for targeted_patch: the coordinator-authorized finding paths. */
	allowedPatchPaths?: string[];
};
export type TargetedPatchSubmission = { patches: Array<{ targetPath: string; replacement: string; evidence: string[] }> };
export { editablePath };
function parts(pointer: string): string[] { return pointer.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~")); }
function setPointer(root: unknown, pointer: string, value: unknown): void {
	const keys = parts(pointer); const finalKey = keys.pop();
	if (!finalKey) throw new Error("Patch path cannot be the document root");
	const parent = keys.reduce<unknown>((node, key) => node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, root);
	if (!parent || typeof parent !== "object" || !(finalKey in parent)) throw new Error(`Patch target does not exist: ${pointer}`);
	(parent as Record<string, unknown>)[finalKey] = value;
}
function evidencePath(target: string): string {
	if (/\/bullets\/\d+\/text$/.test(target)) return target.replace(/\/text$/, "/evidence");
	if (/^\/skills\/\d+\/(?:label|value)$/.test(target)) return target.replace(/\/(?:label|value)$/, "/evidence");
	if (/^\/education\/coursework\/items\/\d+$/.test(target)) return "/education/coursework/evidence";
	throw new Error(`No evidence field for ${target}`);
}
/** Coordinator-only authorization boundary for the xhigh editor; also enforced inside the submission tool. */
export function applyTargetedPatches(plan: ResumePlan, submission: TargetedPatchSubmission, allowedPaths: string[], master: string): ResumePlan {
	const allowed = new Set(allowedPaths); const patched = structuredClone(plan); const seen = new Set<string>();
	for (const patch of submission.patches) {
		if (!allowed.has(patch.targetPath) || !editablePath(patch.targetPath)) throw new Error(`Edit denied. The factual finding applies only to ${allowedPaths.join(", ")}; edits outside that target are not permitted.`);
		if (seen.has(patch.targetPath)) throw new Error(`Edit denied. Duplicate patch target: ${patch.targetPath}`);
		seen.add(patch.targetPath); setPointer(patched, patch.targetPath, patch.replacement); setPointer(patched, evidencePath(patch.targetPath), patch.evidence);
	}
	if (seen.size !== allowed.size) throw new Error("Edit denied. Submit exactly one patch for every reviewer-authorized finding, or remove/shorten the unsupported claim within that target.");
	renderPlan(patched); buildLedger(patched, master); return patched;
}

/** A resume plan has exactly two entry collections; callers that only care about entries (not which heading they render under) can use this. */
export function planEntries(plan: ResumePlan): Array<ResumePlan["workExperience"][number] | ResumePlan["projects"][number]> {
	return [...plan.workExperience, ...plan.projects];
}

function workerReadPaths(kind: WorkerSubmissionKind, context: SubmissionContext): string[] {
	const inJob = (...names: string[]) => names.map(name => path.join(context.folder, name));
	const masterResume = path.join(context.workspace.masterDir, "resume.md");
	if (kind === "requirements") return inJob("job.md");
	if (kind === "facts_review") return inJob(".review-packet-facts.json");
	if (kind === "targeted_patch") return inJob(".review-packet-editor.json");
	if (kind === "resume_draft") return [masterResume, ...inJob("job-requirement.json")];
	if (kind === "cover_letter" || kind === "cover_letter_review") {
		return [
			masterResume,
		...inJob("job-requirement.json", "cover-letter.md", "cover-letter-review.json"),
			...(context.workspace.coverLetterDir ? coverLetterSources(context.workspace.coverLetterDir) : []),
		];
	}
	const exhaustive: never = kind;
	throw new Error(`No read allowlist for worker kind: ${exhaustive}`);
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

/** Absolute paths this worker role may read; existence is checked at read time. */
export function assignedReadPaths(kind: WorkerSubmissionKind, context: SubmissionContext): string[] {
	return workerReadPaths(kind, context);
}

function readableAssignedPaths(kind: WorkerSubmissionKind, context: SubmissionContext): string[] {
	return assignedReadPaths(kind, context)
		.filter(file => {
			try { return fs.existsSync(file) && fs.statSync(file).isFile(); }
			catch { return false; }
		})
		.map(file => fs.realpathSync(file));
}

function readAssignedText(filePath: string, source: string): { content: [{ type: "text"; text: string }]; details: { source: string } } {
	if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error("Assigned pipeline file does not exist");
	const stat = fs.statSync(filePath);
	if (stat.size > MAX_WORKER_READ_BYTES) throw new Error(`Assigned pipeline file must be a regular text file no larger than ${MAX_WORKER_READ_BYTES} bytes`);
	const resolved = fs.realpathSync(filePath);
	return { content: [{ type: "text" as const, text: fs.readFileSync(resolved, "utf8") }], details: { source } };
}

function createFixedFileReadTool(name: string, description: string, filePath: string): ToolDefinition {
	return defineTool({
		name,
		label: name,
		description,
		promptSnippet: description,
		promptGuidelines: [`Call ${name} once. It returns the only assigned source.`],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			return readAssignedText(filePath, name);
		},
	}) as ToolDefinition;
}

function createDrafterReadTool(context: SubmissionContext): ToolDefinition {
	const sources = {
		job_brief: path.join(context.folder, "job-requirement.json"),
		master_resume: path.join(context.workspace.masterDir, "resume.md"),
	} as const;
	return defineTool({
		name: "read_draft_source",
		label: "read_draft_source",
		description: "Read one assigned drafting source. The only options are job_brief and master_resume.",
		promptSnippet: "Read an assigned drafting source",
		promptGuidelines: ["Call read_draft_source with source job_brief or master_resume."],
		parameters: Type.Object({
			source: Type.Union([Type.Literal("job_brief"), Type.Literal("master_resume")]),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			const source = params.source;
			if (source !== "job_brief" && source !== "master_resume") throw new Error("source must be job_brief or master_resume");
			return readAssignedText(sources[source], source);
		},
	}) as ToolDefinition;
}

/** Read access is allowlisted per worker role; job text cannot make a worker explore unrelated files. */
export function createWorkerReadTool(kind: WorkerSubmissionKind, context: SubmissionContext): ToolDefinition {
	if (kind === "resume_draft") return createDrafterReadTool(context);
	if (kind === "facts_review") {
		return createFixedFileReadTool(
			"read_facts_packet",
			"Read the coordinator-built factual-audit packet. This is the only assigned source.",
			path.join(context.folder, ".review-packet-facts.json"),
		);
	}
	if (kind === "targeted_patch") {
		return createFixedFileReadTool(
			"read_editor_packet",
			"Read the coordinator-built editor packet. This is the only assigned source.",
			path.join(context.folder, ".review-packet-editor.json"),
		);
	}
	if (kind === "requirements") {
		return createFixedFileReadTool(
			"read_job_posting",
			"Read the saved job posting. This is the only assigned source.",
			path.join(context.folder, "job.md"),
		);
	}
	const assigned = assignedReadPaths(kind, context);
	return defineTool({
		name: "read_pipeline_file",
		label: "read_pipeline_file",
		description: `Read one coordinator-assigned text artifact. The only readable paths are: ${assigned.join(", ")}. Other filesystem paths are rejected.`,
		promptSnippet: "Read an assigned pipeline input",
		promptGuidelines: ["Use only paths explicitly assigned in the workflow prompt."],
		parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			const allowed = new Set(readableAssignedPaths(kind, context));
			const listed = (allowed.size ? [...allowed] : assigned).join(", ");
			let requested: string;
			try { requested = fs.realpathSync(path.resolve(params.path)); }
			catch { throw new Error(`Assigned pipeline file does not exist. Readable paths: ${listed}`); }
			if (!allowed.has(requested)) throw new Error(`Path is outside this worker's assigned read set. Readable paths: ${listed}`);
			return readAssignedText(requested, "assigned");
		},
	}) as ToolDefinition;
}

function wordCount(value: string): number { return value.trim().split(/\s+/).filter(Boolean).length; }
export function countWords(value: string): number { return wordCount(value); }

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

/** Acronyms that commonly appear across unrelated bullets and should not trigger the recast check. */
const GENERIC_ACRONYMS = new Set([
	"AI", "ML", "NLP", "LLM", "RAG", "API", "AWS", "GCP", "SQL", "GPU", "CPU", "RAM",
	"HTTP", "HTTPS", "REST", "JSON", "HTML", "CSS", "CLI", "SDK", "OS", "UI", "UX",
	"CI", "CD", "QA", "DB", "ID", "IO", "IP", "TCP", "UDP", "SSH", "TLS", "SSL",
	"JWT", "ETL", "DAG", "PDF", "URL", "USB", "SSD", "HPC", "MPC", "RBAC", "OIDC",
	"SWE", "CS", "USA", "NY", "NJ", "CA", "UK", "EU", "SSE",
]);

function workEntrySourceBullets(master: string, headingId: string): Array<{ id: string; text: string }> {
	const section = masterSection(master, "Work Experience");
	const block = section.split(/^### /m).slice(1).find(part => part.startsWith(`[${headingId}]`));
	if (!block) return [];
	return [...block.matchAll(/^[-*]\s+\[([^\]]+)\]\s*(.*)$/gm)].map(match => ({ id: match[1]!, text: match[2] ?? "" }));
}

function distinctiveTokens(text: string): Set<string> {
	const tokens = text.match(/\b[A-Z]{2,6}\b|\bC#\b/g) ?? [];
	return new Set(tokens.filter(token => !GENERIC_ACRONYMS.has(token)));
}

function normalizeCourseName(name: string): string {
	return name.replace(/\.+$/, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}
function courseNamesFromBullet(text: string): string[] {
	const listed = text.match(/:\s*(.*)$/);
	if (!listed?.[1]) return [];
	const list = listed[1].replace(/\.+$/, "").trim();
	const parts = list.includes(";") ? list.split(/\s*;\s*/) : list.split(/,\s*/);
	return parts.map(part => part.trim()).filter(Boolean);
}
function plannedCourseNames(master: string): Set<string> {
	let education: string;
	try { education = masterSection(master, "Education"); }
	catch { return new Set(); }
	const completed = new Set<string>();
	const planned = new Set<string>();
	for (const match of education.matchAll(/^[-*]\s+\[[^\]]+\]\s+(.+)$/gm)) {
		const text = match[1]!;
		const names = courseNamesFromBullet(text).map(normalizeCourseName);
		if (/registered|not yet completed|planned coursework/i.test(text)) {
			for (const name of names) planned.add(name);
		} else if (/\bcompleted\b/i.test(text) && /course/i.test(text)) {
			for (const name of names) completed.add(name);
		}
	}
	return new Set([...planned].filter(name => !completed.has(name)));
}
function assertCourseworkIsCompleted(plan: ResumePlan, master: string): void {
	const blocked = plannedCourseNames(master);
	if (!blocked.size) return;
	const forbidden = plan.education.coursework.items.filter(item => blocked.has(normalizeCourseName(item)));
	if (forbidden.length) {
		throw new Error(`Coursework includes registered or planned course(s): ${forbidden.join(", ")}. Select only completed courses.`);
	}
}

function overusedWorkTopic(entry: ResumePlan["workExperience"][number], sources: Array<{ id: string; text: string }>): string | undefined {
	if (entry.bullets.length < 3 || sources.length < 3) return undefined;
	const tokenSets = entry.bullets.map(bullet => distinctiveTokens(bullet.text));
	const [first, ...rest] = tokenSets;
	if (!first) return undefined;
	for (const token of first) {
		if (!rest.every(set => set.has(token))) continue;
		const missingFromMaster = sources.some(source => !distinctiveTokens(source.text).has(token) && !source.text.includes(token));
		if (missingFromMaster) return token;
	}
	return undefined;
}

function assertWorkExperienceSelection(plan: ResumePlan, master: string): void {
	for (const entry of plan.workExperience) {
		const headingId = entry.evidence[0];
		if (!headingId || entry.bullets.length < 3) continue;
		const sources = workEntrySourceBullets(master, headingId);
		const topic = overusedWorkTopic(entry, sources);
		if (topic) {
			throw new Error(`${entry.title}: every bullet repeats ${topic}, but unused master claims cover other work. Rewrite so each bullet's primary contribution is a different project, system, or outcome; do not recast ${topic} three times.`);
		}
	}
}

function acceptMaterializedDraft(result: ResumePlan, masterText: string, context: SubmissionContext): ResumePlan {
	assertCourseworkIsCompleted(result, masterText);
	assertWorkExperienceSelection(result, masterText);
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

/** Semantic validation runs inside the submission tool and returns errors to the same worker turn. */
export function validateWorkerSubmission(kind: WorkerSubmissionKind, rawValue: unknown, context: SubmissionContext): unknown {
	const master = () => readTextFile(path.join(context.workspace.masterDir, "resume.md"));
	if (kind === "resume_draft" && isResumePlan(rawValue)) {
		return acceptMaterializedDraft(rawValue, master(), context);
	}
	const schema = submissionSchemas[kind] as any;
	const value = coerceJsonStrings(schema, rawValue);
	if (!Check(schema, value)) {
		const first = Errors(schema, value)[0];
		throw new Error(`Invalid ${kind} submission at ${first?.instancePath || "/"}: ${first?.message || "schema mismatch"}`);
	}
	if (kind === "requirements") {
		const validated = validateJobRequirement(value, readTextFile(path.join(context.folder, "job.md")));
		if (validated.job.company !== context.company) throw new Error("job-requirement company must exactly match the assigned company");
		return validated;
	}
	if (kind === "resume_draft") {
		const submitted = value as ResumePlanInput;
		const masterText = master();
		return acceptMaterializedDraft(materializeResumePlan(submitted, masterText), masterText, context);
	}
	if (kind === "facts_review") {
		const plan = readJsonFile<ResumePlan>(path.join(context.folder, "resume-plan.json"));
		const ledger = factualAuditLedger(reviewLedger(buildLedger(plan, master()), master()));
		return validateFactualReview(value, ledger);
	}
	if (kind === "targeted_patch") {
		const patch = value as TargetedPatchSubmission;
		if (context.allowedPatchPaths) {
			const plan = readJsonFile<ResumePlan>(path.join(context.folder, "resume-plan.json"));
			applyTargetedPatches(plan, patch, context.allowedPatchPaths, master());
		}
		return patch;
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
		promptGuidelines: [`Use ${name} as the final action. The coordinator persists the artifact after this tool accepts it.`],
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
					throw new Error(`Measured PDF layout findings: ${rendered.warnings.join("; ")}. Do not call read_draft_source; reuse the plan you just submitted. Change only what these findings require, then call ${name} again with a complete plan that still includes coursework, skills, workExperience, and projects.`);
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
	lines.push("", "## Professional Work Experience");
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
