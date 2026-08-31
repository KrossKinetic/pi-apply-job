/** Deterministically turn a verified resume plan into TeX and a checked PDF. */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LayoutReport } from "./schemas.js";
import { type ApplyJobWorkspace, masterFilePath, readJsonFile, readTextFile, templateFilePath, updateMetadata, writeJsonFile, writeTextFile } from "./utils.js";

const execFileP = promisify(execFile);
const HEADER_MARKER = "%% PI:HEADER";
const CONTENT_MARKER = "%% PI:CONTENT";
type Value = Record<string, unknown>;

export type RenderResult = { texPath: string; pdfPath: string; pageCount: number; passed: boolean };

function object(value: unknown, label: string): Value {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
	return value as Value;
}

function text(value: unknown, label: string, optional = false): string {
	if (optional && (value === undefined || value === null)) return "";
	if (typeof value !== "string" || !value.trim()) throw new Error(label + " must be a non-empty string");
	return value.trim();
}

function sourceIds(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(label + " must contain at least one master-resume evidence ID");
	}
	return value.map((item) => (item as string).trim());
}

/** Collect every evidence reference after renderPlan has validated the plan shape. */
function evidenceIdsInPlan(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(evidenceIdsInPlan);
	if (!value || typeof value !== "object") return [];
	const record = value as Value;
	const ids = Array.isArray(record.evidence)
		? record.evidence.filter((item): item is string => typeof item === "string").map((item) => item.trim())
		: [];
	return ids.concat(Object.entries(record)
		.filter(([key]) => key !== "evidence")
		.flatMap(([, child]) => evidenceIdsInPlan(child)));
}

function evidenceIdsInMaster(master: string): Set<string> {
	const ids = new Set<string>();
	for (const match of master.matchAll(/\[([A-Za-z][A-Za-z0-9-]*)\]/g)) ids.add(match[1]);
	return ids;
}

function assertEvidenceExists(plan: unknown, master: string): void {
	const known = evidenceIdsInMaster(master);
	if (known.size === 0) throw new Error("master/resume.md does not contain any stable evidence IDs");
	const missing = [...new Set(evidenceIdsInPlan(plan).filter((id) => !known.has(id)))];
	if (missing.length > 0) throw new Error("resume-plan.json references unknown master-resume evidence ID(s): " + missing.join(", "));
}

function escapeLatex(value: string): string {
	return value
		.replace(/\\/g, "\\textbackslash{}")
		.replace(/([{}#$%&_])/g, "\\$1")
		.replace(/~/g, "\\textasciitilde{}")
		.replace(/\^/g, "\\textasciicircum{}")
		.replace(/</g, "\\textless{}")
		.replace(/>/g, "\\textgreater{}")
		.replace(/[–—]/g, "--");
}

function renderPlan(value: unknown): { header: string; content: string } {
	const plan = object(value, "resume-plan.json");
	if (plan.schemaVersion !== 1) throw new Error("resume-plan.json schemaVersion must be 1");
	const target = object(plan.target, "target");
	text(target.company, "target.company");
	text(target.role, "target.role");
	const header = object(plan.header, "header");
	const name = text(header.name, "header.name");
	const headline = text(header.headline, "header.headline", true);
	const contactLine = text(header.contactLine, "header.contactLine");
	sourceIds(header.evidence, "header.evidence");
	if (!Array.isArray(plan.sections) || !plan.sections.length) throw new Error("sections must be a non-empty array");

	const sections = plan.sections.map((rawSection, sectionIndex) => {
		const section = object(rawSection, "sections[" + sectionIndex + "]");
		const title = escapeLatex(text(section.title, "section.title"));
		const kind = text(section.kind, "section.kind");
		if (kind === "skills") {
			if (!Array.isArray(section.skills) || !section.skills.length) throw new Error("skills section must be non-empty");
			const skills = section.skills.map((rawSkill) => {
				const skill = object(rawSkill, "skill");
				sourceIds(skill.evidence, "skill.evidence");
				return "\\textbf{" + escapeLatex(text(skill.label, "skill.label")) + "}: " + escapeLatex(text(skill.value, "skill.value"));
			}).join(" \\\\[1mm]\n");
			return "\\section{" + title + "}\n\\begin{itemize}[leftmargin=0.15in, label={}]\n  \\small{\\item{" + skills + "}}\n\\end{itemize}";
		}
		if (kind !== "entries" || !Array.isArray(section.entries) || !section.entries.length) {
			throw new Error("each section must be a non-empty skills or entries section");
		}
		const entries = section.entries.map((rawEntry) => {
			const entry = object(rawEntry, "entry");
			const entryKind = text(entry.kind, "entry.kind", true) || "standard";
			if (entryKind !== "standard" && entryKind !== "project") throw new Error("entry.kind must be standard or project");
			const titleText = escapeLatex(text(entry.title, "entry.title"));
			const dates = escapeLatex(text(entry.dates, "entry.dates", true));
			const subtitle = escapeLatex(text(entry.subtitle, "entry.subtitle", true));
			const location = escapeLatex(text(entry.location, "entry.location", true));
			sourceIds(entry.evidence, "entry.evidence");
			if (!Array.isArray(entry.bullets) || !entry.bullets.length) throw new Error("entry.bullets must be non-empty");
			const bullets = entry.bullets.map((rawBullet) => {
				const bullet = object(rawBullet, "bullet");
				sourceIds(bullet.evidence, "bullet.evidence");
				return "  \\resumeItem{" + escapeLatex(text(bullet.text, "bullet.text")) + "}";
			}).join("\n");
			const heading = entryKind === "project"
				? "\\resumeProjectHeading{\\textbf{" + titleText + "}}{" + dates + "}"
				: "\\resumeSubheading{" + titleText + "}{" + dates + "}{" + subtitle + "}{" + location + "}";
			return heading + "\n\\resumeItemListStart\n" + bullets + "\n\\resumeItemListEnd";
		}).join("\n\\vspace{2pt}\n");
		return "\\section{" + title + "}\n\\resumeSubHeadingListStart\n" + entries + "\n\\resumeSubHeadingListEnd";
	});

	const title = headline ? escapeLatex(name) + " | " + escapeLatex(headline) : escapeLatex(name);
	return {
		header: "\\begin{center}\n  {\\Large \\scshape " + title + "} \\\\[1.5mm]\n  \\footnotesize " + escapeLatex(contactLine) + "\n\\end{center}\n\\vspace{3pt}",
		content: sections.join("\n\\vspace{3pt}\n"),
	};
}

function resolveJobFolder(workspace: ApplyJobWorkspace, requested: string): string {
	const root = path.resolve(workspace.jobsDir);
	const folder = path.resolve(requested);
	if (!folder.startsWith(root + path.sep)) throw new Error("jobFolder must be inside this project's apply-job/jobs directory");
	return folder;
}

async function getPageCount(pdfPath: string): Promise<number> {
	const result = await execFileP("pdfinfo", [pdfPath], { timeout: 15_000 });
	const match = result.stdout.match(/^Pages:\s+(\d+)$/m);
	if (!match) throw new Error("Could not determine the PDF page count");
	return Number(match[1]);
}

function writeLayout(folder: string, report: LayoutReport): void {
	writeJsonFile(path.join(folder, "layout.json"), report);
}

export async function renderResume(workspace: ApplyJobWorkspace, requestedFolder: string): Promise<RenderResult> {
	const folder = resolveJobFolder(workspace, requestedFolder);
	const verification = object(readJsonFile<unknown>(path.join(folder, "verification.json")), "verification.json");
	if (verification.approved !== true) throw new Error("verification.json must approve the resume plan before rendering");
	const plan = readJsonFile<unknown>(path.join(folder, "resume-plan.json"));
	const rendered = renderPlan(plan);
	assertEvidenceExists(plan, readTextFile(masterFilePath(workspace, "resume.md")));
	const template = readTextFile(templateFilePath(workspace));
	if (!template.includes(HEADER_MARKER) || !template.includes(CONTENT_MARKER)) {
		throw new Error("Template must contain " + HEADER_MARKER + " and " + CONTENT_MARKER);
	}
	const texPath = path.join(folder, "resume.tex");
	const pdfPath = path.join(folder, "resume.pdf");
	writeTextFile(texPath, template.replace(HEADER_MARKER, rendered.header).replace(CONTENT_MARKER, rendered.content));
	try {
		await execFileP("tectonic", ["--outdir", folder, texPath], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
		if (!fs.existsSync(pdfPath)) throw new Error("Tectonic completed without creating resume.pdf");
		const pageCount = await getPageCount(pdfPath);
		const passed = pageCount === 1;
		writeLayout(folder, { templateStatus: passed ? "passed" : "ready", compiler: "tectonic", pdfPath, pageCount, passed, warnings: passed ? [] : ["Resume is " + pageCount + " pages; reduce supported content and render again."], checkedAt: new Date().toISOString() });
		updateMetadata(folder, { stage: passed ? "layout_verified" : "rendering", layoutStatus: passed ? "passed" : "ready" });
		return { texPath, pdfPath, pageCount, passed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeLayout(folder, { templateStatus: "failed", compiler: "tectonic", pdfPath: null, pageCount: null, passed: false, warnings: [message], checkedAt: new Date().toISOString() });
		updateMetadata(folder, { stage: "failed", layoutStatus: "failed", lastError: message });
		throw new Error("Unable to render resume: " + message);
	}
}
