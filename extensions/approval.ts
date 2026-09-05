import fs from "node:fs";
import path from "node:path";
import type { ResumePlan } from "./schemas.js";
import { readJsonFile, writeJsonFile, writeTextFile, updateMetadata, type ApplyJobWorkspace } from "./utils.js";
import { finalStamp, loadState, readyForApproval, saveState } from "./review-engine.js";

export const escapeHtml = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
export function writeApprovalPage(folder: string): string {
  const plan = readJsonFile<ResumePlan>(path.join(folder, "resume-plan.json"));
  const show = (name: string) => escapeHtml(fs.existsSync(path.join(folder, name)) ? fs.readFileSync(path.join(folder, name), "utf8") : "Not requested");
  const entries = plan.sections.flatMap(s => s.entries).map(e => `<li><strong>${escapeHtml(e.title)}</strong> — ${escapeHtml(e.subtitle || "")}<ul>${e.bullets.map(b=>`<li>${escapeHtml(b.text)}</li>`).join("")}</ul></li>`).join("");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'; base-uri 'none'; form-action 'none'"><title>Review résumé</title><style>body{font:16px/1.5 system-ui;margin:24px;color:#20252c;background:#f7f8fa}main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}article{min-width:0}img{width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:16px}li{margin:8px 0}a{color:#075ba8}@media(max-width:850px){main{display:block}}</style><h1>${escapeHtml(plan.target.company)} — ${escapeHtml(plan.target.role)}</h1><p>Review the PDF and supporting evidence. Return to Pi to approve, request a revision, or lock selected entries. Closing this page does not approve the résumé.</p><p><a href="resume.pdf">Open PDF</a> · <a href="claim-ledger.json">Claim ledger</a></p><main><article><img src="resume-preview.png" alt="Rendered résumé preview"></article><article><h2>Selected entries</h2><ul>${entries}</ul><h2>Requirement coverage and excluded alternatives</h2><pre>${show("quality-review.json")}</pre><h2>Independent factual findings</h2><pre>${show("independent-verification.json")}</pre><h2>Layout checks</h2><pre>${show("layout.json")}</pre><details><summary>Claim sources</summary><pre>${show("claim-ledger.json")}</pre></details><details><summary>Optional cover letter</summary><pre>${show("cover-letter.md")}</pre></details></article></main></html>`;
  const output = path.join(folder, "review.html"); writeTextFile(output, html); return output;
}
export function approveResume(folder: string, workspace: ApplyJobWorkspace, expected: string): void {
  const state = loadState(folder);
  if (!readyForApproval(folder, workspace, state) || finalStamp(folder, workspace) !== expected) throw new Error("Artifacts changed since review; resume checks before approving");
  if (state.coverLetter && readJsonFile<{ approved: boolean }>(path.join(folder, "cover-letter-review.json")).approved !== true) throw new Error("Cover letter requires approval first");
  state.human = expected; state.humanAt = new Date().toISOString(); saveState(folder, state);
  writeJsonFile(path.join(folder, "human-approval.json"), { approved: true, artifactHash: expected, approvedAt: state.humanAt });
  updateMetadata(folder, { stage: "complete", completedAt: state.humanAt, lastError: null });
}
export function lockEntry(folder: string, title: string | number): void {
  const plan = readJsonFile<ResumePlan>(path.join(folder, "resume-plan.json"));
  const entries = plan.sections.flatMap(s=>s.entries);
  const matches = typeof title === "number" ? entries.slice(title, title + 1) : entries.filter(e=>e.title === title);
  if (matches.length !== 1) throw new Error("Choose a unique entry title to lock");
  const state = loadState(folder);
  state.lockedEntries = [...state.lockedEntries.filter(e=>JSON.stringify(e)!==JSON.stringify(matches[0])), matches[0]];
  saveState(folder, state);
}
