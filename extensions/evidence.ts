import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readTextFile, writeJsonFile } from "./utils.js";

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
  const ledger = buildLedger(JSON.parse(readTextFile(path.join(folder, "resume-plan.json"))), master);
  writeJsonFile(path.join(folder, "claim-ledger.json"), ledger);
  return ledger;
}

export function artifactHash(folder: string, names: string[]): string {
  return hash(JSON.stringify(names.map(name => [name, fs.existsSync(path.join(folder, name)) ? hash(fs.readFileSync(path.join(folder, name)).toString("base64")) : null])));
}

export type Requirement = { id: string; text: string; quote: string; importance: "core" | "supporting" | "optional" };
export function validateRequirements(value: unknown, job: string): Requirement[] {
  const rows = (value as { requirements?: Requirement[] })?.requirements;
  if (!Array.isArray(rows) || !rows.length || rows.length > 20) throw new Error("requirements must contain 1–20 rows");
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id.trim() || ids.has(row.id) || typeof row.text !== "string" || !row.text.trim() || typeof row.quote !== "string" || !row.quote.trim() || !job.includes(row.quote) || !["core", "supporting", "optional"].includes(row.importance)) throw new Error("Each requirement needs a unique ID and exact job-description quote");
    ids.add(row.id);
  }
  return rows;
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
  for (const i of r.issues) if (!i || !validText(i.claim) || !validText(i.reason) || !validText(i.suggestion) || !validIds(i.evidence)) throw new Error("Review issue needs a claim, reason, suggestion, and real master evidence IDs");
  if (requirements) {
    if (!Array.isArray(r.coverage) || r.coverage.length !== requirements.length) throw new Error("Coverage matrix must include every requirement exactly once");
    const remaining = new Set(requirements.map(q => q.id));
    for (const row of r.coverage) {
      if (!row || !remaining.delete(row.requirementId) || !["supported", "unsupported_but_real", "irrelevant"].includes(row.status) || !validText(row.explanation) || !validIds(row.evidence, row.status === "supported") || !Array.isArray(row.claimPaths) || row.claimPaths.some(p => !ledger.claims.some(c => c.path === p))) throw new Error("Invalid requirement coverage row");
      if (row.status === "supported" && (!row.claimPaths.length || row.claimPaths.some(p => !ledger.claims.find(c => c.path === p)!.sources.some(s => row.evidence.includes(s.id))))) throw new Error("Supported requirements need selected claims linked to their evidence");
    }
    if (!Array.isArray(r.alternatives) || r.alternatives.some(a => !a || !validIds(a.evidence) || !validText(a.reason))) throw new Error("Quality review must list evidence-backed excluded alternatives (or an empty array)");
  }
  return r;
}

/** Reviewers may cite unselected master facts; these are not rendered claims. */
export function reviewLedger(ledger: Ledger, master: string): Ledger {
  return { ...ledger, availableSources: [...sourceInventory(master).values()] };
}
