import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { approveResume } from "../extensions/approval.js";
import { applyTargetedPatches, editablePath, finalStamp, loadState, readyForApproval, runReviewEngine, writeEditorPacket, writeReviewPacket, type EnginePorts, type WorkerRole } from "../extensions/review-engine.js";
import { buildLedger, factualAuditLedger, reviewLedger, validateFactualReview } from "../extensions/evidence.js";
import { buildPipelinePrompt, workerSystemPrompt } from "../extensions/workflow.js";
import { planFixture, planSubmissionFixture, setup } from "./fixtures.js";
import { writeJsonFile, writeTextFile } from "../extensions/utils.js";

const filesystemHint = /job-requirement\.json|resume-plan\.json|resume\.md|job\.md|\.review-packet|claim-ledger|master\/resume|no path argument|search for files|read other files|read_pipeline_file/;

const brief = {
  schemaVersion: 1 as const,
  job: { company: "Example", role: "Engineer", roleQuote: "Example" },
  summary: { text: "Python and automated testing are required.", quotes: ["Requires Python and automated testing."] },
  details: [], requirements: [{ id: "R1", text: "Python", quote: "Requires Python and automated testing.", importance: "core" as const }],
  skills: [{ name: "Python", quote: "Requires Python and automated testing.", importance: "core" as const }], responsibilities: [],
};
function draft() { return planSubmissionFixture(); }
function portsFor(f: ReturnType<typeof setup>, response?: (role: WorkerRole, count: number) => unknown) {
  const calls: WorkerRole[] = []; const prompts: Array<{ role: WorkerRole; prompt: string }> = []; let renders = 0;
  const ports: EnginePorts = {
    worker: async (role, prompt) => {
      calls.push(role); prompts.push({ role, prompt });
      return response?.(role, calls.filter(item => item === role).length) ?? (role === "draft" ? draft() : role === "requirements" ? brief : { approved: true, issues: [], summary: "All claims are grounded." });
    },
    render: async () => { renders++; writeTextFile(path.join(f.folder, "resume.pdf"), "pdf"); writeTextFile(path.join(f.folder, "resume-preview.png"), "png"); writeJsonFile(path.join(f.folder, "layout.json"), { passed: true, pageCount: 1, warnings: [] }); return { passed: true, pageCount: 1, warnings: [] }; },
    event: () => {},
  };
  return { ports, calls, prompts, get renders() { return renders; } };
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

test("a tool-materialized draft is accepted without re-checking the worker input schema", async () => {
  const f = setup();
  const mock = portsFor(f, role => role === "draft" ? planFixture() : undefined);
  try {
    await runReviewEngine(f.folder, f.workspace, mock.ports, "draft contract");
    assert.deepEqual(mock.calls, ["requirements", "draft", "facts"]);
    assert.ok(readyForApproval(f.folder, f.workspace));
  } finally { f.cleanup(); }
});

test("factual findings get one path-authorized patch and a full Low re-audit", async () => {
  const f = setup();
  const finding = { approved: false, summary: "Metric is unsupported.", issues: [{ path: "/workExperience/0/bullets/0/text", clause: "50%", reason: "The cited source does not support this metric.", evidence: ["role-03"] }] };
  const mock = portsFor(f, (role, count) => {
    if (role === "facts" && count === 1) return finding;
    if (role === "editor") return { patches: [{ targetPath: "/workExperience/0/bullets/0/text", replacement: "Reduced validation latency through caching.", evidence: ["role-03"] }] };
    return undefined;
  });
  try {
    await runReviewEngine(f.folder, f.workspace, mock.ports, "draft contract");
    assert.deepEqual(mock.calls, ["requirements", "draft", "facts", "editor", "facts"]);
    assert.equal(mock.renders, 2); assert.ok(readyForApproval(f.folder, f.workspace));
    const editorPrompt = mock.prompts.find(item => item.role === "editor")?.prompt || "";
    assert.match(editorPrompt, /Call read_editor_packet once/);
    assert.doesNotMatch(editorPrompt, /resume-plan\.json|read_pipeline_file|no path argument|search for files/);
    const factsPrompt = mock.prompts.find(item => item.role === "facts")?.prompt || "";
    assert.match(factsPrompt, /Call read_facts_packet once/);
    assert.doesNotMatch(factsPrompt, /read_pipeline_file|read other files|no path argument/);
  } finally { f.cleanup(); }
});

test("unauthorized paths are rejected without changing the canonical plan", () => {
  const plan = planFixture(); const before = JSON.stringify(plan); const f = setup();
  try {
    assert.throws(() => applyTargetedPatches(plan, { patches: [{ targetPath: "/workExperience/0/title", replacement: "Changed", evidence: ["role-01"] }] }, ["/workExperience/0/bullets/0/text"], fs.readFileSync(path.join(f.workspace.masterDir, "resume.md"), "utf8")), /Edit denied/);
    assert.equal(JSON.stringify(plan), before);
  } finally { f.cleanup(); }
});

test("findings on coordinator-copied fields are invalid reviews, not human-repair tasks", async () => {
  const f = setup();
  const mock = portsFor(f, role => role === "facts" ? { approved: false, summary: "Title unsupported.", issues: [{ path: "/workExperience/0/title", clause: "Engineer", reason: "Not supported.", evidence: ["role-01"] }] } : undefined);
  try {
    await assert.rejects(() => runReviewEngine(f.folder, f.workspace, mock.ports, "draft contract"), /Invalid factual review after two bounded attempts/);
    assert.equal(mock.calls.includes("editor"), false);
  } finally { f.cleanup(); }
});

test("the same factual finding after a targeted repair stops for human review", async () => {
  const f = setup();
  const finding = { approved: false, summary: "Metric is unsupported.", issues: [{ path: "/workExperience/0/bullets/0/text", clause: "50%", reason: "The cited source does not support this metric.", evidence: ["role-03"] }] };
  const mock = portsFor(f, (role) => {
    if (role === "facts") return finding;
    if (role === "editor") return { patches: [{ targetPath: "/workExperience/0/bullets/0/text", replacement: "Reduced validation latency by 50% through caching.", evidence: ["role-03"] }] };
    return undefined;
  });
  try {
    await runReviewEngine(f.folder, f.workspace, mock.ports, "draft contract");
    assert.equal(mock.calls.filter(role => role === "editor").length, 1);
    assert.match(loadState(f.folder).humanReviewRequired || "", /same factual finding returned/);
    assert.equal(readyForApproval(f.folder, f.workspace), false);
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
    assert.deepEqual(Object.keys(packet.resumePlan).sort(), ["education", "projects", "skills", "workExperience"]);
    assert.equal("resumePreview" in packet, false);
    assert.equal("header" in packet.resumePlan, false);
    assert.deepEqual(packet.resumePlan.education, { coursework: plan.education.coursework });
    assert.ok(packet.claimLedger.claims.every((claim: { path: string }) => editablePath(claim.path)));
    assert.ok(packet.claimLedger.claims.some((claim: { path: string }) => claim.path.startsWith("/education/coursework")));
    assert.equal(packet.claimLedger.claims.some((claim: { path: string }) => /\/(?:title|dates|subtitle|location)$/.test(claim.path) || claim.path.startsWith("/header") || claim.path === "/education/institution" || claim.path.startsWith("/education/honors")), false);
    const audit = factualAuditLedger(ledger);
    assert.throws(() => validateFactualReview({ approved: false, summary: "Name unsupported.", issues: [{ path: "/header/name", clause: "Example Candidate", reason: "Not reviewed.", evidence: ["identity-01"] }] }, audit), /exact canonical/);
  } finally { f.cleanup(); }
});

test("editor packet contains only authorized targets and cited sources", () => {
  const f = setup();
  try {
    const plan = planFixture();
    writeJsonFile(path.join(f.folder, "resume-plan.json"), plan);
    const master = fs.readFileSync(path.join(f.workspace.masterDir, "resume.md"), "utf8");
    const packet = JSON.parse(fs.readFileSync(writeEditorPacket(f.folder, master, {
      kind: "factual",
      allowlist: ["/workExperience/0/bullets/0/text"],
      issues: [{ path: "/workExperience/0/bullets/0/text", clause: "50%", reason: "Unsupported.", evidence: ["role-03"] }],
    }), "utf8"));
    assert.equal(packet.role, "targeted-repair");
    assert.deepEqual(packet.allowlist, ["/workExperience/0/bullets/0/text"]);
    assert.deepEqual(packet.targets, [{ path: "/workExperience/0/bullets/0/text", current: plan.workExperience[0]!.bullets[0]!.text, evidence: ["role-02", "role-03"] }]);
    assert.deepEqual(packet.sourceBlocks.map((source: { id: string }) => source.id).sort(), ["role-02", "role-03"]);
    assert.equal("resumePlan" in packet, false);
  } finally { f.cleanup(); }
});

test("draft, facts, editor, and re-audit prompts never leak filesystem paths", async () => {
  const f = setup();
  const finding = { approved: false, summary: "Metric is unsupported.", issues: [{ path: "/workExperience/0/bullets/0/text", clause: "50%", reason: "The cited source does not support this metric.", evidence: ["role-03"] }] };
  const mock = portsFor(f, (role, count) => {
    if (role === "facts" && count === 1) return finding;
    if (role === "editor") return { patches: [{ targetPath: "/workExperience/0/bullets/0/text", replacement: "Reduced validation latency through caching.", evidence: ["role-03"] }] };
    return undefined;
  });
  try {
    await runReviewEngine(f.folder, f.workspace, mock.ports, (company, role) => buildPipelinePrompt(f.folder, company, role, f.workspace));
    assert.deepEqual(mock.calls, ["requirements", "draft", "facts", "editor", "facts"]);
    assert.ok(readyForApproval(f.folder, f.workspace));
    const byRole = Object.fromEntries(mock.prompts.map(item => [item.role, item.prompt]));
    assert.match(byRole.requirements || "", /Call read_job_posting once/);
    assert.match(byRole.draft || "", /read_draft_source with source job_brief/);
    assert.match(byRole.facts || "", /Call read_facts_packet once/);
    assert.match(byRole.editor || "", /Call read_editor_packet once/);
    assert.match(byRole.facts || "", /\/workExperience\/2\/bullets\/1\/text/);
    assert.match(byRole.editor || "", /allowlisted path/);
    for (const { prompt } of mock.prompts) assert.doesNotMatch(prompt, filesystemHint);
    for (const [role, kind] of [["draft", "resume_draft"], ["facts", "facts_review"], ["editor", "targeted_patch"], ["requirements", "requirements"]] as const) {
      assert.doesNotMatch(workerSystemPrompt(role, kind), filesystemHint);
    }
  } finally { f.cleanup(); }
});
