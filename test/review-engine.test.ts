import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildLedger, sourceInventory, validateReview, validateRequirements } from "../extensions/evidence.js";
import { approveResume, escapeHtml, lockEntry, writeApprovalPage } from "../extensions/approval.js";
import { runReviewEngine, loadState, saveState, finalStamp, readyForApproval, requestRevision, type WorkerRole, type EnginePorts } from "../extensions/review-engine.js";
import { writeJsonFile, writeTextFile } from "../extensions/utils.js";
import { master, planFixture, setup } from "./fixtures.js";
import { captureWorkerSelection } from "../extensions/worker-selection.js";

const requirements = {
  schemaVersion: 1 as const,
  job: { company: "Example", role: "Engineer", roleQuote: "Example" },
  summary: { text: "A software role requiring Python, testing, and graduation in 2027.", quotes: ["Requires Python and automated testing.", "Graduating in 2027."] },
  details: [],
  requirements: [{id:"R1",text:"Python",quote:"Requires Python and automated testing.",importance:"core" as const},{id:"R2",text:"Graduating in 2027",quote:"Graduating in 2027.",importance:"core" as const}],
  skills: [{ name: "Python", quote: "Requires Python and automated testing.", importance: "core" as const }],
  responsibilities: [],
};
function goodReview(role: WorkerRole) {
  return {approved:true,issues:[],summary:"No supported material improvement remains.",...(role==="quality" ? {
    coverage:[{requirementId:"R1",status:"supported",evidence:["skill-01"],claimPaths:["/skills/0/value"],explanation:"Python is in selected skills."},{requirementId:"R2",status:"unsupported_but_real",evidence:[],claimPaths:[],explanation:"2027 graduation is not in the master. Do not invent eligibility."}],
    alternatives:[{evidence:["role-04"],reason:"Team coordination omitted because direct testing evidence is stronger."}],
  }:{})};
}
function draftSubmission(plan=planFixture()) {
  return {
    analysis:{fitScore:8,strengths:["Testing"],weaknesses:[],explicitMatches:["Python"],implicitSkills:[],missingRequirements:[],resumeRecommendations:[]},
    resumePlan:plan,
    verification:{approved:true,issues:[],summary:"Checked."},
  };
}
function portsFor(f: ReturnType<typeof setup>, override?: (role: WorkerRole, count: number)=>unknown) {
  const calls: WorkerRole[]=[]; let renders=0;
  const ports: EnginePorts = {
    worker: async (role,_prompt,submission)=>{
      calls.push(role);
      if(role==="draft" && submission==="verification") return {approved:true,issues:[],summary:"Checked."};
      if(role==="draft") {
        f.draft();
        return draftSubmission(JSON.parse(fs.readFileSync(path.join(f.folder,"resume-plan.json"),"utf8")));
      }
      const value=override?.(role,calls.filter(r=>r===role).length);
      if(value==="NOOP") return;
      return value || (role==="requirements" ? requirements : goodReview(role));
    },
    render: async ()=>{
      renders++;
      writeTextFile(path.join(f.folder,"resume.pdf"),"fixture pdf");
      writeTextFile(path.join(f.folder,"resume-preview.png"),"fixture png");
      writeJsonFile(path.join(f.folder,"layout.json"),{passed:true,pageCount:1,warnings:[]});
      return {passed:true,pageCount:1,warnings:[]};
    }, event: ()=>{},
  };
  return {ports,calls,get renders(){return renders;}};
}
test("ledger maps each selected field to exact original source text including dates",()=>{
  const inventory=sourceInventory(master);
  assert.ok(inventory.get("role-01")!.text.includes("2024 - 2025 | City, ST"));
  assert.ok(!inventory.get("role-01")!.text.includes("[role-02]"));
  const ledger=buildLedger(planFixture(),master);
  const claim=ledger.claims.find(c=>c.path==="/workExperience/0/bullets/1/text")!;
  assert.equal(claim.sources[0].text,"- [role-03] Reduced validation latency by 50% through caching.");
  assert.ok(claim.sources[0].line>0);
  const plan=planFixture(); plan.skills[0].evidence=["invented"];
  assert.throws(()=>buildLedger(plan,master),/Unknown/);
  assert.throws(()=>sourceInventory(master+"\n- [role-03] Duplicate\n"),/Duplicate/);
});
test("a synthesized bullet preserves provenance from every contributing source block",()=>{
  const plan=planFixture();
  plan.workExperience[0].bullets[0]={text:"Built a reliable service with regression tests and reduced validation latency by 50% through caching.",evidence:["role-02","role-03"]};
  const ledger=buildLedger(plan,master);
  const claim=ledger.claims.find(c=>c.path==="/workExperience/0/bullets/0/text")!;
  assert.deepEqual(claim.sources.map(source=>source.id),["role-02","role-03"]);
});
test("strict coverage rejects omitted requirements, invented sources, and contradictory approvals",()=>{
  const ledger=buildLedger(planFixture(),master), req=requirements.requirements;
  assert.throws(()=>validateRequirements(requirements,"unrelated posting"),/exact job/);
  const valid=goodReview("quality");
  validateReview(valid,ledger,req);
  assert.throws(()=>validateReview({...valid,coverage:valid.coverage?.slice(0,1)},ledger,req),/every requirement/);
  assert.throws(()=>validateReview({...valid,issues:[{claim:"X",reason:"Y",suggestion:"Z",evidence:["role-04"]}]},ledger,req),/approval/);
  assert.throws(()=>validateReview({...valid,approved:false,issues:Array.from({length:4},()=>({claim:"X",reason:"Y",suggestion:"Z",evidence:["role-04"]}))},ledger,req),/at most three/);
  assert.throws(()=>validateReview({approved:false,summary:"change",issues:[{claim:"X",reason:"Y",suggestion:"Z",evidence:["invented"]}]},ledger),/real master/);
});
test("requirement quotes tolerate typography normalization but not paraphrased words",()=>{
  const job="Mastercard’s role runs Dec 2026 – June 2027.";
  const normalized={requirements:[{id:"R1",text:"timeline",quote:"Mastercard's role runs Dec 2026 - June 2027.",importance:"core" as const}]};
  assert.equal(validateRequirements(normalized,job).length,1);
  assert.throws(()=>validateRequirements({requirements:[{...normalized.requirements[0],quote:"Mastercard's position runs Dec 2026 - June 2027."}]},job),/exact job/);
});
test("fresh reviews run in order, resume reuses unchanged checkpoints, human approval is version-bound",async()=>{
  const f=setup(); const mock=portsFor(f);
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"draft contract");
    assert.deepEqual(mock.calls,["requirements","draft","facts","quality"]);
    assert.equal(mock.renders,1); assert.ok(readyForApproval(f.folder,f.workspace));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.folder,"metadata.json"),"utf8")).stage,"awaiting_approval");
    const stamp=finalStamp(f.folder,f.workspace);
    const page=writeApprovalPage(f.folder); assert.ok(fs.readFileSync(page,"utf8").includes("resume-preview.png"));
    approveResume(f.folder,f.workspace,stamp);
    await runReviewEngine(f.folder,f.workspace,mock.ports,"unused");
    assert.equal(mock.calls.length,4); assert.equal(mock.renders,1);
    fs.appendFileSync(path.join(f.folder,"resume.md"),"\nChanged");
    assert.throws(()=>approveResume(f.folder,f.workspace,stamp),/changed/);
    await runReviewEngine(f.folder,f.workspace,mock.ports,"unused");
    assert.deepEqual(mock.calls.slice(4),["facts","quality"]);
    assert.equal(mock.renders,2);
  } finally {f.cleanup();}
});
test("reviewers receive a single deterministic packet instead of exploring source files",async()=>{
  const f=setup(); const mock=portsFor(f); const prompts:string[]=[];
  const worker=mock.ports.worker;
  mock.ports.worker=async(role,prompt,submission)=>{prompts.push(prompt); return worker(role,prompt,submission);};
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    const facts=prompts.find(prompt=>prompt.includes(".review-packet-facts.json"))!;
    const quality=prompts.find(prompt=>prompt.includes(".review-packet-quality.json"))!;
    assert.match(facts,/Use read_pipeline_file to read only .*review-packet-facts\.json, exactly once/);
    assert.match(quality,/Use read_pipeline_file to read only .*review-packet-quality\.json, exactly once/);
		assert.match(facts,/final action in this conversation must be exactly one call to the `submit_factual_review` tool/);
		assert.match(quality,/final action in this conversation must be exactly one call to the `submit_quality_review` tool/);
    assert.doesNotMatch(facts,/claim-ledger\.json/);
    assert.ok(fs.existsSync(path.join(f.folder,".review-packet-facts.json")));
    const packet=JSON.parse(fs.readFileSync(path.join(f.folder,".review-packet-quality.json"),"utf8"));
    assert.equal(packet.role,"quality");
    assert.ok(Array.isArray(packet.sourceBlocks));
    assert.deepEqual(packet.reviewRound,{current:1,maximum:4,remainingContentRevisions:3});
  } finally {f.cleanup();}
});
test("a malformed verification schema gets one repair-only pass without spending a content revision",async()=>{
  const f=setup(); const mock=portsFor(f); const prompts:string[]=[];
  const worker=mock.ports.worker;
  mock.ports.worker=async(role,prompt,submission)=>{prompts.push(prompt); return worker(role,prompt,submission);};
  try {
    f.draft();
    writeJsonFile(path.join(f.folder,"verification.json"),{approved:[{claim:"checked"}],issues:[],summary:{verificationStatus:"approved"}});
    const state=loadState(f.folder); state.draftRuns=4; saveState(f.folder,state);
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    const repaired=loadState(f.folder);
    assert.equal(repaired.draftRuns,4);
    assert.equal(repaired.verificationRepairRuns,1);
    assert.ok(prompts.some(prompt=>prompt.includes("REPAIR-ONLY verification-artifact pass")));
    assert.ok(readyForApproval(f.folder,f.workspace));
  }finally{f.cleanup();}
});
test("the quality reviewer receives final-round context and is told not to churn preferences",async()=>{
  const f=setup(); const mock=portsFor(f); const prompts:string[]=[];
  const worker=mock.ports.worker;
  mock.ports.worker=async(role,prompt,submission)=>{prompts.push(prompt); return worker(role,prompt,submission);};
  try {
    f.draft();
    const state=loadState(f.folder); state.draftRuns=4; saveState(f.folder,state);
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    const quality=prompts.find(prompt=>prompt.includes(".review-packet-quality.json"))!;
    assert.match(quality,/Review content attempt 4\/4/);
    assert.match(quality,/never request preference churn/);
    const packet=JSON.parse(fs.readFileSync(path.join(f.folder,".review-packet-quality.json"),"utf8"));
    assert.deepEqual(packet.reviewRound,{current:4,maximum:4,remainingContentRevisions:0});
  }finally{f.cleanup();}
});
test("factual corrections skip quality until a fresh draft is factually approved",async()=>{
  const f=setup(); const mock=portsFor(f,(role,count)=>role==="facts"&&count===1?{approved:false,summary:"Wrong metric",issues:[{claim:"latency",reason:"metric changed",evidence:["role-03"],suggestion:"Restore 50%."}]}:undefined);
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    assert.deepEqual(mock.calls,["requirements","draft","facts","draft","facts","quality"]);
    assert.equal(loadState(f.folder).draftRuns,2);
  } finally{f.cleanup();}
});
test("repeated quality preferences preserve the last factually verified candidate for human review",async()=>{
  const f=setup(); const mock=portsFor(f,role=>role==="quality"?{...goodReview(role),approved:false,issues:[{claim:"testing",reason:"stronger evidence exists",evidence:["role-04"],suggestion:"Use the supported team contribution."}]}:undefined);
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    assert.equal(mock.calls.filter(r=>r==="draft").length,4);
    assert.match(loadState(f.folder).qualityLimitReached || "",/final factually approved candidate is preserved/);
    assert.ok(readyForApproval(f.folder,f.workspace));
    const before=mock.calls.length;
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    assert.equal(mock.calls.length,before);
  }finally{f.cleanup();}
});
test("no-op reviewer cannot inherit an old approved review",async()=>{
  const f=setup(); const mock=portsFor(f,role=>role==="facts"?"NOOP":undefined);
  try {
    writeJsonFile(path.join(f.folder,"independent-verification.json"),goodReview("facts"));
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/Invalid facts review/);
    assert.equal(mock.calls.filter(r=>r==="facts").length,2);
    assert.ok(!mock.calls.includes("quality"));
  }finally{f.cleanup();}
});
test("explicit revision preserves locks and invalidates human approval",async()=>{
  const f=setup(); const mock=portsFor(f);
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    approveResume(f.folder,f.workspace,finalStamp(f.folder,f.workspace));
    lockEntry(f.folder,"Engineer"); requestRevision(f.folder,"Improve the project wording.");
    assert.equal(loadState(f.folder).human,undefined);
    assert.equal(loadState(f.folder).lockedEntries.length,1);
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    assert.deepEqual(mock.calls.slice(4),["draft","facts","quality"]);
  }finally{f.cleanup();}
});
test("a failed draft submission does not consume a content attempt",async()=>{
  const f=setup(); const mock=portsFor(f); const original=mock.ports.worker;
  mock.ports.worker=async(role,prompt,submission)=>{
    if(role==="draft") throw new Error("provider stopped before submission");
    return original(role,prompt,submission);
  };
  try {
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/provider stopped/);
    assert.equal(loadState(f.folder).draftRuns,0);
  }finally{f.cleanup();}
});
test("a rejected locked-entry change is never persisted",async()=>{
  const f=setup(); const mock=portsFor(f);
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    lockEntry(f.folder,"Engineer");
    requestRevision(f.folder,"Improve other entries.");
    const before=fs.readFileSync(path.join(f.folder,"resume-plan.json"),"utf8");
    const original=mock.ports.worker;
    mock.ports.worker=async(role,prompt,submission)=>{
      if(role!=="draft") return original(role,prompt,submission);
      const changed=planFixture(); changed.workExperience[0].bullets[0].text="Changed locked content.";
      return draftSubmission(changed);
    };
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/changed locked entry/);
    assert.equal(fs.readFileSync(path.join(f.folder,"resume-plan.json"),"utf8"),before);
    assert.equal(loadState(f.folder).draftRuns,0);
  }finally{f.cleanup();}
});
test("workers retain the command-time model and thinking pair without quality routing",()=>{
  const speed={provider:"mtplx",id:"mtplx-qwen38-27b-optimized-speed"} as any;
  const quality={provider:"mtplx",id:"mtplx-qwen38-27b-optimized-quality"} as any;
  const ctx={model:speed,thinkingLevel:"high" as const};
  const selection=captureWorkerSelection(ctx);
  assert.equal(selection.model,speed);
  assert.equal(selection.thinkingLevel,"high");
  Object.assign(ctx,{model:quality,thinkingLevel:"off"});
  assert.equal(selection.model,speed);
  assert.equal(selection.thinkingLevel,"high");
  assert.deepEqual(captureWorkerSelection(ctx),{model:quality,thinkingLevel:"off"});
  assert.throws(()=>captureWorkerSelection({model:undefined,thinkingLevel:"off"}),/Select an AI model/);
});
test("review page escapes untrusted text",()=>{
  assert.equal(escapeHtml('<script>"&'),"&lt;script&gt;&quot;&amp;");
});

test("changed master invalidates requirements and both independent approvals without redrafting valid content",async()=>{
  const f=setup(),mock=portsFor(f);
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    fs.appendFileSync(path.join(f.workspace.masterDir,"resume.md"),"\n- [role-11] Additional supported fact.\n");
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    assert.deepEqual(mock.calls.slice(4),["requirements","facts","quality"]);
    assert.equal(mock.renders,2);
  }finally{f.cleanup();}
});
test("a reviewer changing the claim ledger stops the workflow",async()=>{
  const f=setup(),mock=portsFor(f);
  const original=mock.ports.worker;
  mock.ports.worker=async(role,prompt,submission)=>{
    const result=await original(role,prompt,submission);
    if(role==="facts") fs.appendFileSync(path.join(f.folder,"claim-ledger.json")," ");
    return result;
  };
  try {
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/modified reviewed inputs/);
    assert.ok(!mock.calls.includes("quality"));
  }finally{f.cleanup();}
});
test("a persistently broken layout is caught before either reviewer runs, and never exceeds three render attempts",async()=>{
  const f=setup(),mock=portsFor(f);let count=0;
  mock.ports.render=async()=>{count++;return{passed:false,pageCount:1,warnings:["Sparse page"]};};
  try {
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/render attempts exhausted/);
    assert.equal(count,3);
    // Layout is checked before the expensive independent reviewers, so a
    // layout defect that never clears must never spend a facts/quality call.
    assert.equal(mock.calls.filter(r=>r==="facts").length,0);
    assert.equal(mock.calls.filter(r=>r==="quality").length,0);
  }finally{f.cleanup();}
});
test("a measured layout revision remains available after earlier content revisions use the draft cap",async()=>{
  const f=setup(),mock=portsFor(f);
  try {
    const state=loadState(f.folder);
    state.draftRuns=4;
    state.renderRuns=1;
    state.pendingFeedback="Measured PDF layout findings: Expected one page; found 2. Work Experience has a bullet spanning 3 PDF lines; each work bullet must use at most 2 lines.";
    saveState(f.folder,state);
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    assert.ok(mock.calls.includes("draft"));
    assert.equal(mock.renders,1);
    assert.equal(loadState(f.folder).renderRuns,2);
    assert.equal(loadState(f.folder).draftRuns,4);
  }finally{f.cleanup();}
});
test("quality cannot reopen a content tradeoff after its replacement is applied",async()=>{
  const f=setup(); let draftCount=0;
  const originalDraft=f.draft;
  f.draft=(plan=planFixture())=>{
    draftCount++;
    if (draftCount === 2) {
      plan.workExperience[0].bullets[0]={text:"Coordinated releases with a three-person team.",evidence:["role-04"]};
    }
    originalDraft(plan);
  };
  const qualityIssue=(evidence:string)=>({
    ...goodReview("quality"), approved:false, summary:"Use the stronger supported alternative.",
    issues:[{claim:"Selected bullet can be improved.",reason:"A stronger supported fact is available.",evidence:[evidence],suggestion:"Replace the lower-priority bullet."}],
  });
  const mock=portsFor(f,(role,count)=>role==="quality" ? count===1 ? qualityIssue("role-04") : count===2 ? qualityIssue("role-02") : goodReview("quality") : undefined);
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    const stability=loadState(f.folder).qualityStability!;
    assert.deepEqual(stability,[{sourceKey:stability[0].sourceKey,keptEvidence:["role-04"],excludedEvidence:["role-02"]}]);
    assert.equal(mock.calls.filter(role=>role==="quality").length,3);
    // Layout is now confirmed once per distinct content candidate (cheap and
    // immediate) rather than only once at the very end, so each of the three
    // drafted candidates gets its own render check.
    assert.equal(mock.renders,2);
  }finally{f.cleanup();}
});
