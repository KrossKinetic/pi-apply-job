import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { approveResume } from "../extensions/approval.js";
import { applyTargetedPatches, editablePath, finalStamp, loadState, readyForApproval, runReviewEngine, writeReviewPacket, type EnginePorts, type WorkerRole } from "../extensions/review-engine.js";
import { buildLedger, factualAuditLedger, reviewLedger, validateFactualReview } from "../extensions/evidence.js";
import { planFixture, planSubmissionFixture, setup } from "./fixtures.js";
import { writeJsonFile, writeTextFile } from "../extensions/utils.js";

const brief = {
  schemaVersion: 1 as const,
  job: { company: "Example", role: "Engineer", roleQuote: "Example" },
  summary: { text: "Python and automated testing are required.", quotes: ["Requires Python and automated testing."] },
  details: [], requirements: [{ id: "R1", text: "Python", quote: "Requires Python and automated testing.", importance: "core" as const }],
  skills: [{ name: "Python", quote: "Requires Python and automated testing.", importance: "core" as const }], responsibilities: [],
};
function draft() { return planSubmissionFixture(); }
function portsFor(f: ReturnType<typeof setup>, response?: (role: WorkerRole, count: number) => unknown) {
  const calls: WorkerRole[] = []; let renders = 0;
  const ports: EnginePorts = {
    worker: async (role) => { calls.push(role); return response?.(role, calls.filter(item => item === role).length) ?? (role === "draft" ? draft() : role === "requirements" ? brief : { approved: true, issues: [], summary: "All claims are grounded." }); },
    render: async () => { renders++; writeTextFile(path.join(f.folder, "resume.pdf"), "pdf"); writeTextFile(path.join(f.folder, "resume-preview.png"), "png"); writeJsonFile(path.join(f.folder, "layout.json"), { passed: true, pageCount: 1, warnings: [] }); return { passed: true, pageCount: 1, warnings: [] }; },
    event: () => {},
  };
  return { ports, calls, get renders() { return renders; } };
}

test("the new pipeline drafts once, renders deterministically, audits Low facts, then gates human approval", async () => {
  const f = setup(); const mock = portsFor(f);
  try {
    await runReviewEngine(f.folder, f.workspace, mock.ports, "draft contract");
    assert.deepEqual(mock.calls, ["requirements", "draft", "facts"]);
    assert.equal(mock.renders, 1); assert.ok(readyForApproval(f.folder, f.workspace));
    approveResume(f.folder, f.workspace, finalStamp(f.folder, f.workspace));
  } finally { f.cleanup(); }
});

test("factual findings get one path-authorized patch and a full Low re-audit", async () => {
  const f = setup();
  const finding = { approved: false, summary: "Metric is unsupported.", issues: [{ path: "/workExperience/0/bullets/1/text", clause: "50%", reason: "The cited source does not support this metric.", evidence: ["role-03"] }] };
  const mock = portsFor(f, (role, count) => {
    if (role === "facts" && count === 1) return finding;
    if (role === "editor") return { patches: [{ targetPath: "/workExperience/0/bullets/1/text", replacement: "Reduced validation latency through caching.", evidence: ["role-03"] }] };
    return undefined;
  });
  try {
    await runReviewEngine(f.folder, f.workspace, mock.ports, "draft contract");
    assert.deepEqual(mock.calls, ["requirements", "draft", "facts", "editor", "facts"]);
    assert.equal(mock.renders, 2); assert.ok(readyForApproval(f.folder, f.workspace));
  } finally { f.cleanup(); }
});

test("unauthorized paths are rejected without changing the canonical plan", () => {
  const plan = planFixture(); const before = JSON.stringify(plan); const f = setup();
  try {
    assert.throws(() => applyTargetedPatches(plan, { patches: [{ targetPath: "/workExperience/0/title", replacement: "Changed", evidence: ["role-01"] }] }, ["/workExperience/0/bullets/0/text"], fs.readFileSync(path.join(f.workspace.masterDir, "resume.md"), "utf8")), /Edit denied/);
    assert.equal(JSON.stringify(plan), before);
  } finally { f.cleanup(); }
});

test("uneditable or repeated factual findings surface for human review instead of widening scope", async () => {
  const f = setup();
  const mock = portsFor(f, role => role === "facts" ? { approved: false, summary: "Title unsupported.", issues: [{ path: "/workExperience/0/title", clause: "Engineer", reason: "Not supported.", evidence: ["role-01"] }] } : undefined);
  try {
    await runReviewEngine(f.folder, f.workspace, mock.ports, "draft contract");
    assert.equal(mock.calls.includes("editor"), false); assert.match(loadState(f.folder).humanReviewRequired || "", /cannot be repaired/); assert.equal(readyForApproval(f.folder, f.workspace), false);
  } finally { f.cleanup(); }
});

test("factual review requires exact paths, a clause, and examined source IDs", () => {
  const f = setup();
  try {
    const ledger = buildLedger(planFixture(), fs.readFileSync(path.join(f.workspace.masterDir, "resume.md"), "utf8"));
    assert.throws(() => validateFactualReview({ approved: false, summary: "bad", issues: [{ path: "/missing", clause: "x", reason: "x", evidence: ["role-01"] }] }, ledger), /exact canonical/);
    assert.equal(editablePath("/skills/0/value"), true);
    assert.equal(editablePath("/education/coursework/items/0"), true);
    assert.equal(editablePath("/education/gpa"), false);
    assert.equal(editablePath("/workExperience/0/title"), false);
  } finally { f.cleanup(); }
});

test("factual review packet includes only drafter-owned résumé sections", () => {
  const f = setup();
  try {
    const plan = planFixture();
    writeJsonFile(path.join(f.folder, "resume-plan.json"), plan);
    const master = fs.readFileSync(path.join(f.workspace.masterDir, "resume.md"), "utf8");
    const ledger = reviewLedger(buildLedger(plan, master), master);
    const packet = JSON.parse(fs.readFileSync(writeReviewPacket(f.folder, master, ledger), "utf8"));
    assert.equal(packet.schemaVersion, 3);
    assert.deepEqual(Object.keys(packet.resumePlan).sort(), ["coursework", "projects", "skills", "workExperience"]);
    assert.equal("resumePreview" in packet, false);
    assert.equal("header" in packet.resumePlan, false);
    assert.deepEqual(packet.resumePlan.coursework, plan.education.coursework);
    assert.ok(packet.claimLedger.claims.every((claim: { path: string }) => ["/education/coursework", "/skills", "/workExperience", "/projects"].some(prefix => claim.path === prefix || claim.path.startsWith(`${prefix}/`))));
    assert.ok(packet.claimLedger.claims.some((claim: { path: string }) => claim.path.startsWith("/education/coursework")));
    assert.equal(packet.claimLedger.claims.some((claim: { path: string }) => claim.path.startsWith("/header") || claim.path === "/education/institution" || claim.path.startsWith("/education/honors")), false);
    const audit = factualAuditLedger(ledger);
    assert.throws(() => validateFactualReview({ approved: false, summary: "Name unsupported.", issues: [{ path: "/header/name", clause: "Example Candidate", reason: "Not reviewed.", evidence: ["identity-01"] }] }, audit), /exact canonical/);
  } finally { f.cleanup(); }
});
