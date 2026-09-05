import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ResumePlan } from "./schemas.js";
const exec = promisify(execFile);
export type PdfLine = { text: string; x: number; y: number; right: number; bottom: number };
export type PdfPage = { width: number; height: number; lines: PdfLine[] };
export type VisualReport = { passed: boolean; warnings: string[]; pageCount: number; fillRatio: number; skillLineCount: number; previewPaths: string[] };
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
export function checkStructure(plan: ResumePlan): void {
  if (plan.schemaVersion !== 2) throw new Error("Legacy plan needs migration to schemaVersion 2");
  if (!Array.isArray(plan.sections)) throw new Error("Plan sections are missing");
  const entries = plan.sections.flatMap(s => s.entries || []);
  if (entries.length < 2 || entries.length > 5) throw new Error("Select 2–5 jobs/internships/projects in total");
  for (const e of entries) {
    const count = e.bullets?.length ?? 0;
    if (e.kind === "project" ? count !== 1 : count < 2 || count > 3) throw new Error(`${e.title}: jobs/internships need 2–3 bullets; projects need exactly 1`);
  }
  const titles = plan.sections.map(s => s.title);
  if (new Set(titles).size !== titles.length || titles.some(t => !["Work Experience", "Projects"].includes(t))) throw new Error("Work sections must use the fixed titles Work Experience and Projects, without duplicates");
  for (const s of plan.sections) if (s.entries.some(e => (s.title === "Projects") !== (e.kind === "project"))) throw new Error("Place project entries in Projects and jobs/internships in Work Experience");
}
export function inspectGeometry(pages: PdfPage[], plan: ResumePlan, compilerLog = ""): Omit<VisualReport, "previewPaths"> {
  const warnings: string[] = [];
  if (pages.length !== 1) warnings.push(`Expected one page; found ${pages.length}.`);
  const page = pages[0];
  if (!page?.lines.length) return { passed: false, warnings: [...warnings, "PDF has no extractable text."], pageCount: pages.length, fillRatio: 0, skillLineCount: 0 };
  const lines = page.lines;
  const first = lines[0];
  const bottom = Math.max(...lines.map(l => l.bottom));
  const fillRatio = (bottom - first.y) / (page.height - first.y - 36);
  if (fillRatio < 0.72) warnings.push(`Sparse page: content uses ${Math.round(fillRatio * 100)}% of usable vertical space; select more supported content within the entry budget.`);
  if (lines.some(l => l.x < 18 || l.right > page.width - 18 || l.y < 18 || l.bottom > page.height - 18)) warnings.push("Text intrudes into the 18pt page safety margin.");
  if (lines.some(l => l.bottom - l.y < 6.5 && l.text.length > 3)) warnings.push("Text is too small; shorten content instead of shrinking it.");
  const education = lines.find(l => l.text.trim() === "Education");
  const skills = lines.find(l => l.text.trim() === "Technical Skills");
  const work = lines.find(l => plan.sections.some(s => l.text.trim() === s.title));
  if (!education || !skills || !work || education.y >= skills.y || skills.y >= work.y) warnings.push("Section hierarchy must be Education, Technical Skills, then work/projects.");
  const skillLines = skills && work ? lines.filter(l => l.y > skills.bottom && l.y < work.y) : [];
  const skillLineCount = new Set(skillLines.map(l => Math.round(l.y))).size;
  if (skillLineCount < 2 || skillLineCount > 3) warnings.push(`Technical Skills occupies ${skillLineCount} lines; it must occupy 2–3 lines total.`);
  if (education) {
    const header = lines.filter(l => l.y < education.y);
    const titleLines = header.filter(l => l.bottom - l.y >= (first.bottom - first.y) * 0.9);
    if (titleLines.length !== 1) warnings.push("Resume title wraps onto multiple lines.");
    if (Math.abs((first.x + first.right) / 2 - page.width / 2) > 18) warnings.push("Resume title is not centered on the page.");
  }
  let previousBottom = first.bottom;
  for (const l of lines.slice(1)) { if (l.y - previousBottom > 50) warnings.push(`Excessive vertical gap before ${l.text.slice(0, 45)}.`); previousBottom = Math.max(previousBottom, l.bottom); }
  if (/Overfull \\[hv]box|PI-SKILLS-OVERFLOW/.test(compilerLog)) warnings.push("Compiler reports overflowing text; shorten affected content.");
  return { passed: warnings.length === 0, warnings: [...new Set(warnings)], pageCount: pages.length, fillRatio, skillLineCount };
}
export async function inspectPdf(folder: string, plan: ResumePlan, compilerLog: string): Promise<VisualReport> {
  const pdf = path.join(folder, "resume.pdf");
  const { stdout } = await exec("pdftotext", ["-bbox-layout", pdf, "-"], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const pages = parseBoundingBoxes(stdout);
  const geometry = inspectGeometry(pages, plan, compilerLog);
  const prefix = path.join(folder, "resume-preview");
  await exec("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-r", "120", "-png", pdf, prefix], { timeout: 30000 });
  return { ...geometry, previewPaths: [prefix + ".png"] };
}
