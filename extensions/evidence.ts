import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export type Source = { id: string; text: string; line: number };
export type Claim = { path: string; text: string; sources: Source[] };
export type Ledger = { masterHash: string; planHash: string; claims: Claim[]; availableSources?: Source[] };

/** Preserve the exact source block, including role dates between a heading and its bullets. */
export function sourceInventory(master: string): Map<string, Source> {
  const matches = [...master.matchAll(/^(?:#{1,6}\s+|[-*]\s+)\[([A-Za-z][\w-]*)\][^\n]*(?:\n(?!\s*(?:#{1,6}\s|[-*]\s+\[))[^\n]*)*/gm)];
  const sources = new Map<string, Source>();
  for (const match of matches) {
    if (sources.has(match[1])) throw new Error(`Duplicate master evidence ID: ${match[1]}`);
    sources.set(match[1], { id: match[1], text: match[0].trimEnd(), line: master.slice(0, match.index).split("\n").length });
  }
  if (!sources.size) throw new Error("Master resume contains no stable evidence blocks");
  return sources;
}

export function buildLedger(plan: unknown, master: string): Ledger {
  const inventory = sourceInventory(master);
  const claims: Claim[] = [];
  function visit(value: unknown, pointer: string, inherited: string[] = []) {
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${pointer}/${i}`, inherited)); return; }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const ids = record.evidence === undefined ? inherited : record.evidence;
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !inventory.has(id))) throw new Error(`Unknown master-resume evidence ID at ${pointer}`);
      for (const [key, child] of Object.entries(record)) {
        if (key === "evidence") continue;
        visit(child, `${pointer}/${key}`, ids);
      }
    } else if (typeof value === "string" && value.trim()) {
      if (!inherited.length) throw new Error(`Claim at ${pointer} has no evidence`);
      claims.push({ path: pointer, text: value, sources: inherited.map(id => inventory.get(id)!) });
    }
  }
  visit(plan, "");
  return { masterHash: hash(master), planHash: hash(JSON.stringify(plan)), claims, availableSources: [...inventory.values()] };
}

export function artifactHash(folder: string, names: string[]): string {
  return hash(JSON.stringify(names.map(name => [name, fs.existsSync(path.join(folder, name)) ? hash(fs.readFileSync(path.join(folder, name)).toString("base64")) : null])));
}

export type Requirement = { id: string; text: string; quote: string; importance: "core" | "supporting" | "optional" };
export type JobRequirement = {
  schemaVersion: 1;
  job: { company: string; role: string; roleQuote: string };
  summary: { text: string; quotes: string[] };
  details: Array<{ label: string; text: string; quote: string }>;
  requirements: Requirement[];
  skills: Array<{ name: string; quote: string; importance: "core" | "supporting" | "optional" }>;
  responsibilities: Array<{ text: string; quote: string }>;
};
/** Compare extracted quotes exactly in meaning while tolerating scraper/model typography normalization only. */
function normalizedQuote(value: string): string {
  return value.normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
export function validateRequirements(value: unknown, job: string): Requirement[] {
  const rows = (value as { requirements?: Requirement[] })?.requirements;
  if (!Array.isArray(rows) || !rows.length || rows.length > 20) throw new Error("requirements must contain 1–20 rows");
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id.trim() || ids.has(row.id) || typeof row.text !== "string" || !row.text.trim() || typeof row.quote !== "string" || !row.quote.trim() || !normalizedQuote(job).includes(normalizedQuote(row.quote)) || !["core", "supporting", "optional"].includes(row.importance)) throw new Error("Each requirement needs a unique ID and exact job-description quote");
    ids.add(row.id);
  }
  return rows;
}

/** Validate that every source-backed job fact in the AI summary is grounded in the raw posting. */
export function validateJobRequirement(value: unknown, job: string): JobRequirement {
  const result = value as JobRequirement;
  const source = normalizedQuote(job);
  const quoted = (quote: unknown, label: string) => {
    if (typeof quote !== "string" || !quote.trim() || !source.includes(normalizedQuote(quote))) {
      throw new Error(`${label} needs an exact job-description quote`);
    }
  };
  if (!result || result.schemaVersion !== 1 || !result.job || typeof result.job.company !== "string" || !result.job.company.trim() || typeof result.job.role !== "string" || !result.job.role.trim()) {
    throw new Error("job-requirement must include a company and role");
  }
  quoted(result.job.roleQuote, "job.roleQuote");
  if (!result.summary || typeof result.summary.text !== "string" || !result.summary.text.trim() || !Array.isArray(result.summary.quotes) || result.summary.quotes.length < 1 || result.summary.quotes.length > 6) {
    throw new Error("summary needs concise text and 1–6 supporting quotes");
  }
  result.summary.quotes.forEach((quote, index) => quoted(quote, `summary.quotes[${index}]`));
  const sourceFacts = (rows: unknown, label: string, name: "text" | "name" = "text") => {
    if (!Array.isArray(rows)) throw new Error(`${label} must be an array`);
    rows.forEach((row, index) => {
      if (!row || typeof row !== "object" || typeof (row as Record<string, unknown>)[name] !== "string" || !(row as Record<string, unknown>)[name]?.toString().trim()) throw new Error(`${label}[${index}] needs ${name}`);
      quoted((row as { quote?: unknown }).quote, `${label}[${index}].quote`);
    });
  };
  if (!Array.isArray(result.details) || result.details.length > 10) throw new Error("details must contain at most 10 entries");
  result.details.forEach((detail, index) => {
    if (!detail || !detail.label?.trim() || !detail.text?.trim()) throw new Error(`details[${index}] needs label and text`);
    quoted(detail.quote, `details[${index}].quote`);
  });
  const requirements = validateRequirements(result, job);
  if (!Array.isArray(result.skills) || result.skills.length > 20) throw new Error("skills must contain at most 20 entries");
  sourceFacts(result.skills, "skills", "name");
  if (result.skills.some(skill => !["core", "supporting", "optional"].includes(skill.importance))) throw new Error("skills need a valid importance");
  if (!Array.isArray(result.responsibilities) || result.responsibilities.length > 12) throw new Error("responsibilities must contain at most 12 entries");
  sourceFacts(result.responsibilities, "responsibilities");
  return { ...result, requirements };
}

/** A factual finding is deliberately narrow: it names the canonical claim
 * path, the offending clause, why it is unsupported, and every source block
 * examined. It has no ATS, completeness, keyword, or style fields. */
export type FactualReview = {
  approved: boolean; summary: string;
  issues: { path: string; clause: string; reason: string; evidence: string[] }[];
};

/** Validate the factual-only review used by the Low audit worker. */
export function validateFactualReview(value: unknown, ledger: Ledger): FactualReview {
  const review = value as FactualReview;
  const known = new Set([...ledger.claims.flatMap(claim => claim.sources.map(source => source.id)), ...(ledger.availableSources || []).map(source => source.id)]);
  const validText = (text: unknown): text is string => typeof text === "string" && !!text.trim();
  if (!review || typeof review.approved !== "boolean" || !validText(review.summary) || !Array.isArray(review.issues) || review.approved !== (review.issues.length === 0)) {
    throw new Error("Factual-review approval must agree with a concrete issues array and summary");
  }
  for (const [index, issue] of review.issues.entries()) {
    const claim = issue && typeof issue === "object" && validText((issue as { path?: unknown }).path) ? ledger.claims.find(item => item.path === (issue as { path: string }).path) : undefined;
    if (!claim) throw new Error(`issues[${index}].path must be an exact canonical claim path`);
    if (!validText(issue.clause) || !validText(issue.reason)) throw new Error(`issues[${index}] needs a non-empty affected clause and reason`);
    if (!claim.text.includes(issue.clause)) throw new Error(`issues[${index}].clause must occur in the claim at its canonical path`);
    if (!Array.isArray(issue.evidence) || !issue.evidence.length || issue.evidence.some(id => typeof id !== "string" || !known.has(id))) throw new Error(`issues[${index}].evidence must list real examined master-resume evidence IDs`);
  }
  return review;
}

/** Reviewers may cite unselected master facts; these are not rendered claims. */
export function reviewLedger(ledger: Ledger, master: string): Ledger {
  return { ...ledger, availableSources: [...sourceInventory(master).values()] };
}

/** Drafter-owned leaf fields the Low auditor may flag and the xhigh editor may patch. */
export function editablePath(pointer: string): boolean {
  return /^\/education\/coursework\/items\/\d+$/.test(pointer)
    || /^\/skills\/\d+\/(?:label|value)$/.test(pointer)
    || /^\/workExperience\/\d+\/bullets\/\d+\/text$/.test(pointer)
    || /^\/projects\/\d+\/bullets\/\d+\/text$/.test(pointer);
}

/** Header, honors, and coordinator-copied titles/dates/employers are not in the factual-audit lane. */
export function factualAuditLedger(ledger: Ledger): Ledger {
  return {
    ...ledger,
    claims: ledger.claims.filter(claim => editablePath(claim.path)),
  };
}
