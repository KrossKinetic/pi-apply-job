import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./utils.js";

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
        if (["evidence", "kind", "schemaVersion", "target"].includes(key)) continue;
        // Section names are structural labels, not candidate claims.
        if (key === "title" && pointer.match(/^\/sections\/\d+$/)) continue;
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

export function writeLedger(folder: string, master: string): Ledger {
  const ledger = buildLedger(readJsonFile(path.join(folder, "resume-plan.json")), master);
  writeJsonFile(path.join(folder, "claim-ledger.json"), ledger);
  return ledger;
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

export type Review = {
  approved: boolean; summary: string;
  issues: { claim: string; reason: string; evidence: string[]; suggestion: string }[];
  coverage?: { requirementId: string; status: "supported" | "unsupported_but_real" | "irrelevant"; evidence: string[]; claimPaths: string[]; explanation: string }[];
  alternatives?: { evidence: string[]; reason: string }[];
};
export function validateReview(value: unknown, ledger: Ledger, requirements?: Requirement[]): Review {
  const r = value as Review;
  const known = new Set([...ledger.claims.flatMap(c => c.sources.map(s => s.id)), ...(ledger.availableSources || []).map(s => s.id)]);
  const validText = (s: unknown): s is string => typeof s === "string" && !!s.trim();
  const validIds = (ids: unknown, requireOne = true): ids is string[] => Array.isArray(ids) && (!requireOne || ids.length > 0) && ids.every(id => typeof id === "string" && known.has(id));
  if (!r || typeof r.approved !== "boolean" || !validText(r.summary) || !Array.isArray(r.issues) || r.approved !== (r.issues.length === 0)) throw new Error("Review approval must agree with a concrete issues array and summary");
  for (const [index, i] of r.issues.entries()) {
    // One error per concrete cause, naming the exact field: a reviewer that
    // gets "needs a claim, reason, suggestion, and real evidence IDs" for
    // any one of four unrelated mistakes has nothing to act on and tends to
    // resubmit the same broken issue unchanged.
    if (!i || typeof i !== "object") throw new Error(`issues[${index}] must be an object with claim, reason, evidence, and suggestion`);
    if (!validText(i.claim)) throw new Error(`issues[${index}].claim must be a non-empty string`);
    if (!validText(i.reason)) throw new Error(`issues[${index}].reason must be a non-empty string`);
    if (!validText(i.suggestion)) throw new Error(`issues[${index}].suggestion must be a non-empty string`);
    if (!validIds(i.evidence)) throw new Error(`issues[${index}].evidence must be a non-empty array of real master-resume evidence IDs (unknown or missing IDs are rejected)`);
  }
  if (requirements) {
    if (r.issues.length > 3) throw new Error("Quality review must prioritize at most three material improvements");
    if (!Array.isArray(r.coverage) || r.coverage.length !== requirements.length) throw new Error("Coverage matrix must include every requirement exactly once");
    const remaining = new Set(requirements.map(q => q.id));
    for (const row of r.coverage) {
      if (!row || !remaining.delete(row.requirementId) || !["supported", "unsupported_but_real", "irrelevant"].includes(row.status) || !validText(row.explanation) || !validIds(row.evidence, row.status === "supported") || !Array.isArray(row.claimPaths) || row.claimPaths.some(p => !ledger.claims.some(c => c.path === p))) throw new Error("Invalid requirement coverage row");
      if (row.status === "supported" && (!row.claimPaths.length || row.claimPaths.some(p => !ledger.claims.find(c => c.path === p)!.sources.some(s => row.evidence.includes(s.id))))) throw new Error("Supported requirements need selected claims linked to their evidence");
    }
    // Evidence may legitimately be empty here: excluding a requirement because
    // no master-resume support exists is an absence claim, and there is no
    // source ID to cite for something that isn't in the master resume.
    if (!Array.isArray(r.alternatives) || r.alternatives.some(a => !a || !validIds(a.evidence, false) || !validText(a.reason))) throw new Error("Quality review must list excluded alternatives with a reason, citing real master evidence IDs when any exist");
  }
  return r;
}

/** Reviewers may cite unselected master facts; these are not rendered claims. */
export function reviewLedger(ledger: Ledger, master: string): Ledger {
  return { ...ledger, availableSources: [...sourceInventory(master).values()] };
}
