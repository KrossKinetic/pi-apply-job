import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { ResumePlan } from "./schemas.js";
const exec = promisify(execFile);
export type PdfLine = { text: string; x: number; y: number; right: number; bottom: number };
export type PdfPage = { width: number; height: number; lines: PdfLine[] };
export type VisualReport = { passed: boolean; warnings: string[]; pageCount: number; fillRatio: number; skillLineCount: number; workBulletLineCounts: number[]; previewPaths: string[] };
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
/**
 * The visible submission schema already enforces per-entry shape (dates/subtitle/
 * location required for workExperience, bullet counts, additionalProperties, etc.)
 * and the fixed "Work Experience" / "Projects" headings are owned entirely by the
 * renderer rather than supplied by the worker, so there is no title/kind field left
 * to misuse. This function is a defense-in-depth check for plans loaded back off
 * disk (which may not have passed through the tool schema, e.g. after manual edits)
 * plus the one cross-array invariant TypeBox min/max cannot express: the total
 * entry count across both arrays.
 */
export function checkStructure(plan: ResumePlan): void {
  if (!Array.isArray(plan.workExperience) || !Array.isArray(plan.projects)) throw new Error("Plan workExperience/projects are missing");
  if (plan.workExperience.length + plan.projects.length !== 5) throw new Error("Select exactly 5 jobs/internships/projects in total");
  if (plan.workExperience.length < 3) throw new Error("Select at least 3 jobs/internships/research entries");
  for (const e of plan.workExperience) {
    const count = e.bullets?.length ?? 0;
    if (count < 2 || count > 3) throw new Error(`${e.title}: jobs/internships need 2–3 bullets; projects need exactly 1`);
    if (![e.dates, e.subtitle, e.location].every(value => typeof value === "string" && value.trim())) {
      throw new Error(`${e.title}: Work Experience entries require non-empty dates, employer subtitle, and location`);
    }
  }
  for (const e of plan.projects) {
    const count = e.bullets?.length ?? 0;
    if (count !== 1) throw new Error(`${e.title}: jobs/internships need 2–3 bullets; projects need exactly 1`);
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
/** Count physical PDF lines touched by a bullet on one PDF page. */
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
/** Count every standard Work Experience bullet, even when the PDF overflows to a second page. */
function workBulletLineCounts(pages: PdfPage[], plan: ResumePlan): { counts: number[]; unmapped: string[] } {
  const counts: number[] = [];
  const unmapped: string[] = [];
  for (const entry of plan.workExperience) {
    for (const bullet of entry.bullets) {
      const matches = pages.flatMap(page => page.lines.length ? [bulletLineCount(page.lines, bullet.text)] : []).filter((count): count is number => count !== undefined);
      if (matches.length === 1) counts.push(matches[0]);
      else unmapped.push(bullet.text);
    }
  }
  return { counts, unmapped };
}
export function inspectGeometry(pages: PdfPage[], plan: ResumePlan, compilerLog = ""): Omit<VisualReport, "previewPaths"> {
  const warnings: string[] = [];
  if (pages.length !== 1) warnings.push(`Expected one page; found ${pages.length}.`);
  const bulletMapping = workBulletLineCounts(pages, plan);
  if (bulletMapping.unmapped.length) warnings.push(`Could not map ${bulletMapping.unmapped.length} rendered Work Experience bullet${bulletMapping.unmapped.length === 1 ? "" : "s"} to PDF text.`);
  if (bulletMapping.counts.some(count => count > 2)) warnings.push(`Work Experience has a bullet spanning ${Math.max(...bulletMapping.counts)} PDF lines; each work bullet must use at most 2 lines.`);
  if (pages.length !== 1) return { passed: false, warnings: [...new Set(warnings)], pageCount: pages.length, fillRatio: 0, skillLineCount: 0, workBulletLineCounts: bulletMapping.counts };
  const page = pages[0];
  if (!page?.lines.length) return { passed: false, warnings: [...warnings, "PDF has no extractable text."], pageCount: pages.length, fillRatio: 0, skillLineCount: 0, workBulletLineCounts: [] };
  const lines = page.lines;
  const first = lines[0];
  const bottom = Math.max(...lines.map(l => l.bottom));
  const fillRatio = (bottom - first.y) / (page.height - first.y - 36);
  if (fillRatio < 0.72) warnings.push(`Sparse page: content uses ${Math.round(fillRatio * 100)}% of usable vertical space; select more supported content within the entry budget.`);
  if (lines.some(l => l.x < 18 || l.right > page.width - 18 || l.y < 18 || l.bottom > page.height - 18)) warnings.push("Text intrudes into the 18pt page safety margin.");
  if (lines.some(l => l.bottom - l.y < 6.5 && l.text.length > 3)) warnings.push("Text is too small; shorten content instead of shrinking it.");
  const education = lines.find(l => l.text.trim() === "Education");
  const skills = lines.find(l => l.text.trim() === "Technical Skills");
  const work = lines.find(l => l.text.trim() === "Work Experience");
  if (!education || !skills || !work || education.y >= skills.y || skills.y >= work.y) warnings.push("Section hierarchy must be Education, Technical Skills, then work/projects.");
  const skillLines = skills && work ? lines.filter(l => l.y > skills.bottom && l.y < work.y) : [];
  const skillLineCount = new Set(skillLines.map(l => Math.round(l.y))).size;
  if (skillLineCount < 2 || skillLineCount > 3) warnings.push(`Technical Skills occupies ${skillLineCount} lines; it must occupy 2–3 lines total.`);
  const bulletLineCounts = bulletMapping.counts;
  if (education) {
    const header = lines.filter(l => l.y < education.y);
    const titleLines = header.filter(l => l.bottom - l.y >= (first.bottom - first.y) * 0.9);
    if (titleLines.length !== 1) warnings.push("Resume title wraps onto multiple lines.");
    if (Math.abs((first.x + first.right) / 2 - page.width / 2) > 18) warnings.push("Resume title is not centered on the page.");
  }
  let previousBottom = first.bottom;
  for (const l of lines.slice(1)) { if (l.y - previousBottom > 50) warnings.push(`Excessive vertical gap before ${l.text.slice(0, 45)}.`); previousBottom = Math.max(previousBottom, l.bottom); }
  if (/Overfull \\[hv]box|PI-SKILLS-OVERFLOW/.test(compilerLog)) warnings.push("Compiler reports overflowing text; shorten affected content.");
  return { passed: warnings.length === 0, warnings: [...new Set(warnings)], pageCount: pages.length, fillRatio, skillLineCount, workBulletLineCounts: bulletLineCounts };
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
