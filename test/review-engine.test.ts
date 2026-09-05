import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildLedger, sourceInventory, validateReview, validateRequirements } from "../extensions/evidence.js";
import { approveResume, escapeHtml, lockEntry, writeApprovalPage } from "../extensions/approval.js";
import { runReviewEngine, loadState, finalStamp, readyForApproval, requestRevision, type WorkerRole, type EnginePorts } from "../extensions/review-engine.js";
import { writeJsonFile, writeTextFile } from "../extensions/utils.js";
import { master, planFixture, setup } from "./fixtures.js";
import { captureWorkerSelection } from "../extensions/worker-selection.js";

const requirements = {requirements:[{id:"R1",text:"Python",quote:"Requires Python and automated testing.",importance:"core" as const},{id:"R2",text:"Graduating in 2027",quote:"Graduating in 2027.",importance:"core" as const}]};
function goodReview(role: WorkerRole) {
  return {approved:true,issues:[],summary:"No supported material improvement remains.",...(role==="quality" ? {
    coverage:[{requirementId:"R1",status:"supported",evidence:["skill-01"],claimPaths:["/skills/0/value"],explanation:"Python is in selected skills."},{requirementId:"R2",status:"unsupported_but_real",evidence:[],claimPaths:[],explanation:"2027 graduation is not in the master. Do not invent eligibility."}],
    alternatives:[{evidence:["role-04"],reason:"Team coordination omitted because direct testing evidence is stronger."}],
  }:{})};
}
function portsFor(f: ReturnType<typeof setup>, override?: (role: WorkerRole, count: number)=>unknown) {
  const calls: WorkerRole[]=[]; let renders=0;
  const ports: EnginePorts = {
    worker: async (role,prompt)=>{
      calls.push(role);
      if(role==="draft") { f.draft(); return; }
      const output=prompt.match(/Write only (.+), as valid JSON, then stop\.$/)?.[1];
      assert.ok(output);
      const value=override?.(role,calls.filter(r=>r===role).length);
      if(value==="NOOP") return;
      writeJsonFile(output,value || (role==="requirements" ? requirements : goodReview(role)));
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
  const claim=ledger.claims.find(c=>c.path==="/sections/0/entries/0/bullets/1/text")!;
  assert.equal(claim.sources[0].text,"- [role-03] Reduced validation latency by 50% through caching.");
  assert.ok(claim.sources[0].line>0);
  const plan=planFixture(); plan.skills[0].evidence=["invented"];
  assert.throws(()=>buildLedger(plan,master),/Unknown/);
  assert.throws(()=>sourceInventory(master+"\n- [role-03] Duplicate\n"),/Duplicate/);
});
test("strict coverage rejects omitted requirements, invented sources, and contradictory approvals",()=>{
  const ledger=buildLedger(planFixture(),master), req=requirements.requirements;
  assert.throws(()=>validateRequirements(requirements,"unrelated posting"),/exact job/);
  const valid=goodReview("quality");
  validateReview(valid,ledger,req);
  assert.throws(()=>validateReview({...valid,coverage:valid.coverage?.slice(0,1)},ledger,req),/every requirement/);
  assert.throws(()=>validateReview({...valid,issues:[{claim:"X",reason:"Y",suggestion:"Z",evidence:["role-04"]}]},ledger,req),/approval/);
  assert.throws(()=>validateReview({approved:false,summary:"change",issues:[{claim:"X",reason:"Y",suggestion:"Z",evidence:["invented"]}]},ledger),/real master/);
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
test("factual corrections skip quality until a fresh draft is factually approved",async()=>{
  const f=setup(); const mock=portsFor(f,(role,count)=>role==="facts"&&count===1?{approved:false,summary:"Wrong metric",issues:[{claim:"latency",reason:"metric changed",evidence:["role-03"],suggestion:"Restore 50%."}]}:undefined);
  try {
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    assert.deepEqual(mock.calls,["requirements","draft","facts","draft","facts","quality"]);
    assert.equal(loadState(f.folder).draftRuns,2);
  } finally{f.cleanup();}
});
test("repeated quality rejection reaches a global persisted revision cap, including after restart",async()=>{
  const f=setup(); const mock=portsFor(f,role=>role==="quality"?{...goodReview(role),approved:false,issues:[{claim:"testing",reason:"stronger evidence exists",evidence:["role-04"],suggestion:"Use the supported team contribution."}]}:undefined);
  try {
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/revision limit/);
    assert.equal(mock.calls.filter(r=>r==="draft").length,4);
    const before=mock.calls.length;
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/revision limit/);
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
    fs.appendFileSync(path.join(f.workspace.masterDir,"resume.md"),"\n- [role-05] Additional supported fact.\n");
    await runReviewEngine(f.folder,f.workspace,mock.ports,"contract");
    assert.deepEqual(mock.calls.slice(4),["requirements","facts","quality"]);
    assert.equal(mock.renders,2);
  }finally{f.cleanup();}
});
test("a reviewer changing the claim ledger stops the workflow",async()=>{
  const f=setup(),mock=portsFor(f);
  const original=mock.ports.worker;
  mock.ports.worker=async(role,prompt)=>{
    await original(role,prompt);
    if(role==="facts") fs.appendFileSync(path.join(f.folder,"claim-ledger.json")," ");
  };
  try {
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/modified reviewed inputs/);
    assert.ok(!mock.calls.includes("quality"));
  }finally{f.cleanup();}
});
test("layout revisions rerun both reviewers and never exceed three render attempts",async()=>{
  const f=setup(),mock=portsFor(f);let count=0;
  mock.ports.render=async()=>{count++;return{passed:false,pageCount:1,warnings:["Sparse page"]};};
  try {
    await assert.rejects(runReviewEngine(f.folder,f.workspace,mock.ports,"contract"),/render attempts exhausted/);
    assert.equal(count,3);
    assert.equal(mock.calls.filter(r=>r==="facts").length,3);
    assert.equal(mock.calls.filter(r=>r==="quality").length,3);
  }finally{f.cleanup();}
});
