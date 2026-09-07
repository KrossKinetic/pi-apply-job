import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { ResumePlan } from "./schemas.js";
const exec = promisify(execFile);
export type PdfLine = { text: string; x: number; y: number; right: number; bottom: number };
export type PdfPage = { width: number; height: number; lines: PdfLine[] };
export type VisualReport = {
	passed: boolean; warnings: string[]; pageCount: number; fillRatio: number;
	skillLineCount: number; courseworkLineCount: number;
	workBulletLineCounts: number[]; projectBulletLineCounts: number[]; previewPaths: string[];
};
export const MIN_PAGE_FILL_RATIO = 0.85;
const PRIMARY_WORK_BULLETS = [3, 3, 2] as const;
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function attr(tag: string, key: string) { const m = tag.match(new RegExp(`${key}="([0-9.]+)"`)); if (!m) throw new Error(`Missing PDF coordinate ${key}`); return Number(m[1]); }
export function parseBoundingBoxes(xml: string): PdfPage[] {
	return [...xml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)].map(p => ({
		width: attr(p[1], "width"), height: attr(p[1], "height"),
		lines: [...p[2].matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/g)].map(l => ({
			text: [...l[2].matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/g)].map(w => decode(w[1])).join(" "),
			x: attr(l[1], "xMin"), y: attr(l[1], "yMin"), right: attr(l[1], "xMax"), bottom: attr(l[1], "yMax"),
		})).sort((a,b) => a.y - b.y || a.x - b.x),
	}));
}
export function workBulletCountsFor(plan: Pick<ResumePlan, "workExperience">): number[] {
	return plan.workExperience.length === 4 ? [...PRIMARY_WORK_BULLETS, 2] : [...PRIMARY_WORK_BULLETS];
}
/**
 * Defense-in-depth for plans loaded off disk. The one-page budget is 3 work
 * entries at 3/3/2 bullets plus 2 projects, or 4 work entries at 3/3/2/2 plus
 * 1 project. The renderer owns section titles.
 */
export function checkStructure(plan: ResumePlan): void {
	if (!Array.isArray(plan.workExperience) || !Array.isArray(plan.projects)) throw new Error("Plan workExperience/projects are missing");
	const work = plan.workExperience.length;
	const projects = plan.projects.length;
	if (work + projects !== 5) throw new Error("Select exactly 5 jobs/internships/projects in total");
	if (!((work === 3 && projects === 2) || (work === 4 && projects === 1))) {
		throw new Error("Use 3 work entries and 2 projects, or 4 work entries and 1 project");
	}
	const required = workBulletCountsFor(plan);
	for (const [index, entry] of plan.workExperience.entries()) {
		const count = entry.bullets?.length ?? 0;
		if (count !== required[index]) throw new Error(`${entry.title}: workExperience[${index}] must have ${required[index]} bullets`);
		if (![entry.dates, entry.subtitle, entry.location].every(value => typeof value === "string" && value.trim())) {
			throw new Error(`${entry.title}: Work Experience entries require non-empty dates, employer subtitle, and location`);
		}
	}
	for (const entry of plan.projects) {
		if ((entry.bullets?.length ?? 0) !== 1) throw new Error(`${entry.title}: each project needs exactly 1 bullet`);
	}
}
const normalizePdfText = (text: string) => text.normalize("NFKC").toLocaleLowerCase();
const tokens = (text: string) => normalizePdfText(text).match(/[\p{L}\p{N}]+/gu) || [];
type PositionedToken = { text: string; line: number; hyphenated: boolean };
function pdfTokens(lines: PdfLine[]): PositionedToken[] {
	return lines.flatMap((line, lineIndex) =>
		(normalizePdfText(line.text).match(/[\p{L}\p{N}]+-?/gu) || []).map((word) => ({
			text: word.replace(/-$/, ""), line: lineIndex, hyphenated: word.endsWith("-"),
		})),
	);
}
function bulletLineCount(lines: PdfLine[], bullet: string): number | undefined {
	const pageTokens = pdfTokens(lines);
	const target = tokens(bullet);
	for (let start = 0; start < pageTokens.length; start++) {
		let tokenIndex = start;
		const touched = new Set<number>();
		let matched = true;
		for (const token of target) {
			const current = pageTokens[tokenIndex];
			if (!current) { matched = false; break; }
			if (current.text === token) {
				touched.add(current.line); tokenIndex++;
			} else if (current.hyphenated && pageTokens[tokenIndex + 1] && current.text + pageTokens[tokenIndex + 1].text === token) {
				touched.add(current.line); touched.add(pageTokens[tokenIndex + 1].line); tokenIndex += 2;
			} else { matched = false; break; }
		}
		if (matched) return touched.size;
	}
	return undefined;
}
function mapBullets(pages: PdfPage[], bullets: string[]): { counts: number[]; unmapped: string[] } {
	const counts: number[] = [];
	const unmapped: string[] = [];
	for (const bullet of bullets) {
		const matches = pages.flatMap(page => page.lines.length ? [bulletLineCount(page.lines, bullet)] : []).filter((count): count is number => count !== undefined);
		if (matches.length === 1) counts.push(matches[0]);
		else unmapped.push(bullet);
	}
	return { counts, unmapped };
}
function heading(lines: PdfLine[], pattern: RegExp): PdfLine | undefined {
	return lines.find(line => pattern.test(line.text.trim()));
}
function uniqueRows(lines: PdfLine[]): number {
	return new Set(lines.map(line => Math.round(line.y))).size;
}
export function inspectGeometry(pages: PdfPage[], plan: ResumePlan, compilerLog = ""): Omit<VisualReport, "previewPaths"> {
	const warnings: string[] = [];
	if (pages.length !== 1) warnings.push(`Expected one page; found ${pages.length}.`);
	const workTexts = plan.workExperience.flatMap(entry => entry.bullets.map(bullet => bullet.text));
	const projectTexts = plan.projects.flatMap(entry => entry.bullets.map(bullet => bullet.text));
	const workMapping = mapBullets(pages, workTexts);
	const projectMapping = mapBullets(pages, projectTexts);
	if (workMapping.unmapped.length) warnings.push(`Could not map ${workMapping.unmapped.length} rendered Work Experience bullet${workMapping.unmapped.length === 1 ? "" : "s"} to PDF text.`);
	if (projectMapping.unmapped.length) warnings.push(`Could not map ${projectMapping.unmapped.length} rendered project bullet${projectMapping.unmapped.length === 1 ? "" : "s"} to PDF text.`);
	let workOffset = 0;
	for (const [index, entry] of plan.workExperience.entries()) {
		const n = entry.bullets.length;
		const slice = workMapping.counts.slice(workOffset, workOffset + n);
		workOffset += n;
		if (slice.length !== n) continue;
		if (index < 3) {
			if (slice.some(count => count > 2)) warnings.push(`Work Experience has a bullet spanning ${Math.max(...slice)} PDF lines; the first three jobs' bullets must use at most 2 lines each.`);
		} else {
			const sum = slice.reduce((total, count) => total + count, 0);
			if (sum !== 3) warnings.push(`Fourth work entry bullets occupy ${sum} PDF lines; they must occupy 3 lines total.`);
		}
	}
	if (projectMapping.counts.some(count => count < 2 || count > 3)) {
		warnings.push(`A project bullet occupies ${projectMapping.counts.find(count => count < 2 || count > 3)} PDF lines; each project bullet must occupy 2–3 lines.`);
	}
	if (/Overfull \\[hv]box/.test(compilerLog)) warnings.push("Compiler reports overflowing text; shorten affected content.");
	const empty = { passed: false, warnings: [...new Set(warnings)], pageCount: pages.length, fillRatio: 0, skillLineCount: 0, courseworkLineCount: 0, workBulletLineCounts: workMapping.counts, projectBulletLineCounts: projectMapping.counts };
	const page = pages[0];
	if (!page?.lines.length) return { ...empty, warnings: [...new Set([...warnings, "PDF has no extractable text."])] };
	const lines = page.lines;
	const first = lines[0];
	const bottom = Math.max(...lines.map(l => l.bottom));
	const fillRatio = (bottom - first.y) / (page.height - first.y - 36);
	if (pages.length === 1 && fillRatio < MIN_PAGE_FILL_RATIO) warnings.push(`Sparse page: content uses ${Math.round(fillRatio * 100)}% of usable vertical space; fill the one-page budget instead of leaving the lower half empty.`);
	if (lines.some(l => l.x < 18 || l.right > page.width - 18 || l.y < 18 || l.bottom > page.height - 18)) warnings.push("Text intrudes into the 18pt page safety margin.");
	if (lines.some(l => l.bottom - l.y < 6.5 && l.text.length > 3)) warnings.push("Text is too small; shorten content instead of shrinking it.");
	const skills = heading(lines, /^technical skills$/i);
	const work = heading(lines, /^(professional )?work experience$/i);
	if (!skills || !work || skills.y >= work.y) warnings.push("Section hierarchy must be Technical Skills, then Professional Work Experience.");
	const skillLines = skills && work ? lines.filter(l => l.y > skills.bottom && l.y < work.y && l.text.trim()) : [];
	const skillLineCount = uniqueRows(skillLines);
	if (skillLineCount < 1 || skillLineCount > 3) warnings.push(`Technical Skills occupies ${skillLineCount} lines; it must occupy at most 3 lines total.`);
	const courseworkStart = lines.find(line => /coursework/i.test(line.text) && (!skills || line.y < skills.y));
	const courseworkLines = courseworkStart && skills
		? lines.filter(line => line.y >= courseworkStart.y - 0.5 && line.y < skills.y && line.text.trim())
		: [];
	const courseworkLineCount = uniqueRows(courseworkLines);
	if (!courseworkStart || courseworkLineCount !== 2) warnings.push(`Relevant Coursework occupies ${courseworkLineCount} lines; it must occupy exactly 2 lines.`);
	const name = plan.header.name.trim();
	const institution = plan.education.institution.trim();
	const folded = (value: string) => value.replace(/\s+/g, " ").toLocaleLowerCase();
	const uni = lines.find(line => institution && line.text.includes(institution))
		|| lines.find(line => {
			const token = institution.split(/\s+/).filter(word => word.length > 2 && !name.toLocaleLowerCase().includes(word.toLocaleLowerCase())).sort((a, b) => b.length - a.length)[0];
			return Boolean(token && line.text.includes(token));
		});
	const header = uni ? lines.filter(line => line.y < uni.y) : lines.filter(line => !skills || line.y < skills.y).slice(0, 4);
	const titleLines = header.filter(line => folded(line.text).includes(folded(name)));
	if (titleLines.length !== 1) warnings.push("Resume title wraps onto multiple lines.");
	if (Math.abs((first.x + first.right) / 2 - page.width / 2) > 18) warnings.push("Resume title is not centered on the page.");
	let previousBottom = first.bottom;
	for (const l of lines.slice(1)) { if (l.y - previousBottom > 50) warnings.push(`Excessive vertical gap before ${l.text.slice(0, 45)}.`); previousBottom = Math.max(previousBottom, l.bottom); }
	return {
		passed: warnings.length === 0, warnings: [...new Set(warnings)], pageCount: pages.length, fillRatio,
		skillLineCount, courseworkLineCount, workBulletLineCounts: workMapping.counts, projectBulletLineCounts: projectMapping.counts,
	};
}
export async function inspectPdf(folder: string, plan: ResumePlan, compilerLog: string): Promise<VisualReport> {
	const pdf = path.join(folder, "resume.pdf");
	const { stdout } = await exec("pdftotext", ["-bbox-layout", pdf, "-"], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
	const pages = parseBoundingBoxes(stdout);
	const geometry = inspectGeometry(pages, plan, compilerLog);
	const prefix = path.join(folder, "resume-preview");
	await exec("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-r", "120", "-png", pdf, prefix], { timeout: 30000 });
	fs.chmodSync(prefix + ".png", 0o600);
	return { ...geometry, previewPaths: [prefix + ".png"] };
}
