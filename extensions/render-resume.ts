/** Deterministically turn a verified resume plan into TeX and a checked PDF. */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LayoutReport } from "./schemas.js";
import type { ResumePlan } from "./schemas.js";
import { checkStructure, inspectPdf, workBulletCountsFor } from "./layout-qa.js";
import { type ApplyJobWorkspace, masterFilePath, readJsonFile, readTextFile, templateFilePath, updateMetadata, writeJsonFile, writeTextFile } from "./utils.js";

const execFileP = promisify(execFile);
const HEADER_MARKER = "%% PI:HEADER";
const CONTENT_MARKER = "%% PI:CONTENT";
type Value = Record<string, unknown>;

export type RenderResult = { texPath: string; pdfPath: string; pageCount: number; passed: boolean; warnings: string[] };

function object(value: unknown, label: string): Value {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
	return value as Value;
}

function text(value: unknown, label: string, optional = false): string {
	if (optional && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) return "";
	if (typeof value !== "string" || !value.trim()) throw new Error(label + " must be a non-empty string");
	return value.trim();
}

function sourceIds(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(label + " must contain at least one master-resume evidence ID");
	}
	return value.map((item) => (item as string).trim());
}

function textItems(value: unknown, label: string, maxItems: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(label + " must be an array of at most " + maxItems + " non-empty strings");
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
function escapeHref(url: string): string {
	return url.replace(/([#%\\])/g, "\\$1");
}
type ContactPart = { icon: string; display: string; href?: string };
function parseContactParts(contactLine: string): ContactPart[] {
	return contactLine.split(/\s*\|\s*/).map(part => part.trim()).filter(Boolean).map(part => {
		const labeled = part.match(/^([^:]+):\s*(.+)$/);
		const label = (labeled?.[1] || "").toLowerCase();
		const value = labeled?.[2] || part;
		if (label.includes("phone") || /^\+?\d/.test(value.replace(/[\s().-]/g, ""))) return { icon: "\\faPhone", display: value };
		if (label.includes("email") || value.includes("@")) return { icon: "\\faEnvelope", display: value.replace(/^mailto:/i, ""), href: "mailto:" + value.replace(/^mailto:/i, "") };
		if (label.includes("linkedin") || /linkedin\.com/i.test(value)) {
			const href = value.startsWith("http") ? value : `https://${value.replace(/^\/+/, "")}`;
			return { icon: "\\faLinkedin", display: href.replace(/^https?:\/\/(www\.)?/i, ""), href };
		}
		if (label.includes("github") || /github\.com/i.test(value)) {
			const href = value.startsWith("http") ? value : `https://${value.replace(/^\/+/, "")}`;
			return { icon: "\\faGithub", display: href.replace(/^https?:\/\/(www\.)?/i, ""), href };
		}
		const href = value.startsWith("http") ? value : undefined;
		return { icon: "\\faBriefcase", display: href ? href.replace(/^https?:\/\/(www\.)?/i, "") : value, href };
	});
}
function renderContactRow(parts: ContactPart[]): string {
	return parts.map(part => {
		const body = part.href
			? `${part.icon}\\ \\href{${escapeHref(part.href)}}{${escapeLatex(part.display)}}`
			: `${part.icon}\\ \\underline{${escapeLatex(part.display)}}`;
		return `{${body}}`;
	}).join(" ~\n    ");
}

function stripRepeatedGpa(degree: string, gpa: string): string {
	if (!gpa) return degree;
	const match = degree.match(/(?:\s*[,—–-]\s*)?GPA\s*:\s*([0-9.]+\s*\/\s*[0-9.]+)\s*$/i);
	if (!match || match[1].replace(/\s/g, "") !== gpa.replace(/\s/g, "")) return degree;
	return degree.slice(0, match.index).trim();
}

export function renderPlan(value: unknown): { header: string; content: string } {
	checkStructure(value as ResumePlan);
	const plan = object(value, "resume-plan.json");
	const header = object(plan.header, "header");
	const name = text(header.name, "header.name");
	text(header.headline, "header.headline", true);
	const contactLine = text(header.contactLine, "header.contactLine");
	sourceIds(header.evidence, "header.evidence");
	const education = object(plan.education, "education");
	const institution = escapeLatex(text(education.institution, "education.institution"));
	const rawGpa = text(education.gpa, "education.gpa", true);
	const degree = escapeLatex(stripRepeatedGpa(text(education.degree, "education.degree"), rawGpa));
	const gpa = escapeLatex(rawGpa);
	const educationDates = escapeLatex(text(education.dates, "education.dates"));
	const educationLocation = escapeLatex(text(education.location, "education.location"));
	sourceIds(education.evidence, "education.evidence");
	const honors = object(education.honors, "education.honors");
	const honorItems = textItems(honors.items, "education.honors.items", 4);
	if (honorItems.length) sourceIds(honors.evidence, "education.honors.evidence");
	const coursework = object(education.coursework, "education.coursework");
	const courseworkItems = textItems(coursework.items, "education.coursework.items", 8);
	if (courseworkItems.length) sourceIds(coursework.evidence, "education.coursework.evidence");
	if (!Array.isArray(plan.skills) || plan.skills.length < 1 || plan.skills.length > 3) {
		throw new Error("skills must contain 1–3 categories");
	}
	const skillLines = plan.skills.map((rawSkill) => {
		const skill = object(rawSkill, "skill");
		sourceIds(skill.evidence, "skill.evidence");
		return "\\textbf{" + escapeLatex(text(skill.label, "skill.label")) + "}{: " + escapeLatex(text(skill.value, "skill.value")) + "}";
	}).join(" \\\\[1mm]\n   ");
	const bulletsTex = (rawBullets: unknown, label: string, count: number) => {
		if (!Array.isArray(rawBullets) || rawBullets.length !== count) {
			throw new Error(`${label} must contain exactly ${count} bullet(s)`);
		}
		return rawBullets.map((rawBullet, bulletIndex) => {
			const bullet = object(rawBullet, `${label}[${bulletIndex}]`);
			sourceIds(bullet.evidence, `${label}[${bulletIndex}].evidence`);
			return "  \\resumeItem{" + escapeLatex(text(bullet.text, `${label}[${bulletIndex}].text`)) + "}";
		}).join("\n");
	};
	const workCounts = workBulletCountsFor({ workExperience: plan.workExperience as ResumePlan["workExperience"] });
	const workEntries = (plan.workExperience as unknown[]).map((rawEntry, index) => {
		const label = `workExperience[${index}]`;
		const entry = object(rawEntry, label);
		const titleText = escapeLatex(text(entry.title, `${label}.title`));
		const dates = escapeLatex(text(entry.dates, `${label}.dates`));
		const subtitle = escapeLatex(text(entry.subtitle, `${label}.subtitle`));
		const location = escapeLatex(text(entry.location, `${label}.location`));
		sourceIds(entry.evidence, `${label}.evidence`);
		const bullets = bulletsTex(entry.bullets, `${label}.bullets`, workCounts[index]!);
		const heading = "\\resumeSubheading{" + titleText + "}{" + dates + "}{" + subtitle + "}{" + location + "}";
		return heading + "\n\\resumeItemListStart\n" + bullets + "\n\\resumeItemListEnd";
	}).join("\n");
	const workSection = "\\section{Professional Work Experience}\n\\resumeSubHeadingListStart\n" + workEntries + "\n\\resumeSubHeadingListEnd";
	const projectEntries = (plan.projects as unknown[]).map((rawEntry, index) => {
		const label = `projects[${index}]`;
		const entry = object(rawEntry, label);
		const titleText = escapeLatex(text(entry.title, `${label}.title`));
		const dates = escapeLatex(text(entry.dates, `${label}.dates`, true));
		sourceIds(entry.evidence, `${label}.evidence`);
		const bullets = bulletsTex(entry.bullets, `${label}.bullets`, 1);
		const heading = "\\resumeProjectHeading{\\textbf{" + titleText + "}}{" + dates + "}";
		return heading + "\n\\resumeItemListStart\n" + bullets + "\n\\resumeItemListEnd";
	}).join("\n");
	const projectsSection = "\\section{Projects}\n\\resumeSubHeadingListStart\n" + projectEntries + "\n\\resumeSubHeadingListEnd";
	const degreeLine = degree + (gpa ? " --- GPA: " + gpa : "");
	const educationRows = [
		"      \\textbf{" + institution + "} & \\textbf{\\small " + educationDates + "} \\\\",
		"      \\textit{\\small " + degreeLine + "} & \\textit{\\small " + educationLocation + "} \\\\[1mm]",
		honorItems.length ? "      \\multicolumn{2}{p{\\linewidth}}{\\small\\textbf{Honors / Awards}{: " + honorItems.map(escapeLatex).join(", ") + "}} \\\\[1mm]" : "",
		courseworkItems.length ? "      \\multicolumn{2}{p{\\linewidth}}{\\small\\textbf{Relevant Coursework}{: " + courseworkItems.map(escapeLatex).join(", ") + "}}" : "",
	].filter(Boolean).join("\n");
	const educationContent = "\\resumeSubHeadingListStart\n    \\vspace{-10pt}\\item\n    \\begin{tabular*}{1.0\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}\n" + educationRows + "\n    \\end{tabular*}\\vspace{-8pt}\n\\resumeSubHeadingListEnd";
	const skillContent = "\\section{Technical Skills}\n\\begin{itemize}[leftmargin=0.15in, label={}]\n  \\small{\\item{\n   " + skillLines + "\n  }}\n\\end{itemize}";
	const contacts = parseContactParts(contactLine);
	const primary = contacts.filter(part => part.icon === "\\faPhone" || part.icon === "\\faEnvelope");
	const social = contacts.filter(part => part.icon !== "\\faPhone" && part.icon !== "\\faEnvelope");
	const firstRow = renderContactRow(primary.length ? primary : contacts);
	const secondRow = primary.length ? renderContactRow(social) : "";
	const headerTex = [
		"\\begin{center}",
		"    {\\Large \\scshape " + escapeLatex(name) + "} \\\\[2mm]",
		"    \\footnotesize",
		"    " + firstRow,
		"\\end{center}",
		secondRow ? "\\begin{center}\n    " + secondRow + "\n    \\vspace{-8pt}\n\\end{center}" : "\\vspace{-8pt}",
		"\\hrulefill",
	].join("\n");
	return { header: headerTex, content: [educationContent, skillContent, workSection, projectsSection].join("\n") };
}

function resolveJobFolder(workspace: ApplyJobWorkspace, requested: string): string {
	const root = fs.realpathSync(workspace.jobsDir);
	const folder = fs.realpathSync(path.resolve(requested));
	if (!folder.startsWith(root + path.sep)) throw new Error("jobFolder must be inside the user-wide apply-job/jobs directory");
	return folder;
}

function writeLayout(folder: string, report: LayoutReport): void {
	writeJsonFile(path.join(folder, "layout.json"), report);
}

export async function renderResume(workspace: ApplyJobWorkspace, requestedFolder: string): Promise<RenderResult> {
	const folder = resolveJobFolder(workspace, requestedFolder);
	const plan = readJsonFile<unknown>(path.join(folder, "resume-plan.json"));
	const rendered = renderPlan(plan);
	assertEvidenceExists(plan, readTextFile(masterFilePath(workspace, "resume.md")));
	const template = readTextFile(templateFilePath(workspace));
	if (!template.includes(HEADER_MARKER) || !template.includes(CONTENT_MARKER)) {
		throw new Error("Template must contain " + HEADER_MARKER + " and " + CONTENT_MARKER);
	}
	if (!template.includes("\\begin{document}")) throw new Error("Template must contain \\begin{document}");
	const renderTemplate = template.includes("\\usepackage{graphicx}")
		? template
		: template.replace("\\begin{document}", "\\usepackage{graphicx}\n\\begin{document}");
	const texPath = path.join(folder, "resume.tex");
	const pdfPath = path.join(folder, "resume.pdf");
	writeTextFile(texPath, renderTemplate.replace(HEADER_MARKER, rendered.header).replace(CONTENT_MARKER, rendered.content));
	try {
		const compiled = await execFileP("tectonic", ["--outdir", folder, texPath], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
		if (!fs.existsSync(pdfPath)) throw new Error("Tectonic completed without creating resume.pdf");
		fs.chmodSync(pdfPath, 0o600);
		const visual = await inspectPdf(folder, plan as ResumePlan, compiled.stdout + compiled.stderr);
		const { pageCount, passed, warnings } = visual;
		writeJsonFile(path.join(folder, "visual-qa.json"), visual);
		writeLayout(folder, { templateStatus: passed ? "passed" : "ready", compiler: "tectonic", pdfPath, pageCount, passed, warnings, checkedAt: new Date().toISOString() });
		updateMetadata(folder, {
			stage: passed ? "layout_verified" : "rendering",
			layoutStatus: passed ? "passed" : "ready",
			lastError: null,
		});
		return { texPath, pdfPath, pageCount, passed, warnings };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeLayout(folder, { templateStatus: "failed", compiler: "tectonic", pdfPath: null, pageCount: null, passed: false, warnings: [message], checkedAt: new Date().toISOString() });
		updateMetadata(folder, { stage: "failed", layoutStatus: "failed", lastError: message });
		throw new Error("Unable to render resume: " + message);
	}
}
