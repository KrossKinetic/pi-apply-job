import assert from "node:assert/strict";
import test from "node:test";
import { checkStructure, inspectGeometry, parseBoundingBoxes, type PdfLine } from "../extensions/layout-qa.js";
import { planFixture } from "./fixtures.js";
const line=(text:string,y:number,x=40,right=550,height=10):PdfLine=>({text,y,x,right,bottom:y+height});
test("layout flags wrapping headers, missing hierarchy, and excess skill lines",()=>{
  const lines=[line("Example Candidate",40,130,480,16),line("Long generated headline",58,120,490,16),line("Education",100),line("University",130),line("Technical Skills",200),line("Languages",220),line("More",234),line("More",248),line("More",262),line("Work Experience",300),line("Bottom",700)];
  const result=inspectGeometry([{width:612,height:792,lines}],planFixture());
  assert.ok(result.warnings.some(w=>w.includes("title wraps")));
  assert.ok(result.warnings.some(w=>w.includes("4 lines")));
  assert.ok(inspectGeometry([{width:612,height:792,lines:lines.filter(l=>l.text!=="Education")}],planFixture()).warnings.some(w=>w.includes("hierarchy")));
});
test("entry and bullet limits are code constraints",()=>{
  const plan=planFixture(); checkStructure(plan);
  plan.sections[0].entries[0].bullets.pop(); assert.throws(()=>checkStructure(plan),/2–3 bullets/);
  const project=planFixture(); project.sections[1].entries[0].bullets.push(project.sections[1].entries[0].bullets[0]); assert.throws(()=>checkStructure(project),/exactly 1/);
});
test("Poppler XML is parsed and entities decoded",()=>{
  const pages=parseBoundingBoxes('<page width="612" height="792"><flow><block><line xMin="40" yMin="40" xMax="80" yMax="50"><word xMin="40">A &amp; B</word></line></block></flow></page>');
  assert.equal(pages[0].lines[0].text,"A & B");
});
