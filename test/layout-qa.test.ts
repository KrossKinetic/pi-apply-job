import assert from "node:assert/strict";
import test from "node:test";
import { checkStructure, inspectGeometry, parseBoundingBoxes, type PdfLine } from "../extensions/layout-qa.js";
import { planFixture } from "./fixtures.js";
const line=(text:string,y:number,x=40,right=550,height=10):PdfLine=>({text,y,x,right,bottom:y+height});
const workBulletLines=(startY:number) => planFixture().workExperience.flatMap(entry => entry.bullets.map((bullet,index) => line(bullet.text,startY + (index * 14))));
test("layout flags wrapping headers, missing hierarchy, and excess skill lines",()=>{
  const lines=[line("Example Candidate",40,130,480,16),line("Long generated headline",58,120,490,16),line("Education",100),line("University",130),line("Technical Skills",200),line("Languages",220),line("More",234),line("More",248),line("More",262),line("Work Experience",300),...workBulletLines(330),line("Bottom",700)];
  const result=inspectGeometry([{width:612,height:792,lines}],planFixture());
  assert.ok(result.warnings.some(w=>w.includes("title wraps")));
  assert.ok(result.warnings.some(w=>w.includes("4 lines")));
  assert.ok(inspectGeometry([{width:612,height:792,lines:lines.filter(l=>l.text!=="Education")}],planFixture()).warnings.some(w=>w.includes("hierarchy")));
});
test("entry and bullet limits are code constraints",()=>{
  const plan=planFixture(); checkStructure(plan);
  plan.workExperience[0].bullets.pop(); assert.throws(()=>checkStructure(plan),/2–3 bullets/);
  const project=planFixture(); project.projects[0].bullets.push(project.projects[0].bullets[0]); assert.throws(()=>checkStructure(project),/exactly 1/);
  const tooFew=planFixture(); tooFew.projects.pop(); assert.throws(()=>checkStructure(tooFew),/exactly 5/);
  const tooFewWork=planFixture();
  tooFewWork.workExperience.splice(2,1);
  tooFewWork.projects.push({title:"Third Project",dates:"2021",evidence:["project-03"],bullets:[{text:"Built a typed API prototype with automated request validation.",evidence:["project-04"]}]});
  assert.throws(()=>checkStructure(tooFewWork),/at least 3/);
  const missingEmployer=planFixture(); missingEmployer.workExperience[0].subtitle=""; assert.throws(()=>checkStructure(missingEmployer),/non-empty dates, employer subtitle, and location/);
});

test("layout rejects a work-experience bullet that spans three PDF lines",()=>{
  const plan=planFixture();
  const bullet=plan.workExperience[0].bullets[0].text;
  const words=bullet.split(" ");
  const lines=[
    line("Example Candidate",40,130,480,16), line("Education",100), line("Technical Skills",200), line("Languages",220), line("Tools",234), line("Work Experience",300),
    line(words.slice(0,3).join(" "),330), line(words.slice(3,6).join(" "),344), line(words.slice(6).join(" "),358), ...workBulletLines(380).slice(1),
    line("Bottom",700),
  ];
  const result=inspectGeometry([{width:612,height:792,lines}],plan);
  assert.ok(result.warnings.some(w=>w.includes("bullet spanning 3 PDF lines")));
});
test("two-page PDFs still report work-bullet line violations for a targeted revision",()=>{
  const plan=planFixture();
  const bullet=plan.workExperience[0].bullets[0].text;
  const words=bullet.split(" ");
  const firstPage=[
    line("Example Candidate",40,130,480,16), line("Education",100), line("Technical Skills",200), line("Languages",220), line("Tools",234), line("Work Experience",300),
    line(words.slice(0,3).join(" "),330), line(words.slice(3,6).join(" "),344), line(words.slice(6).join(" "),358), ...workBulletLines(380).slice(1),
  ];
  const result=inspectGeometry([{width:612,height:792,lines:firstPage},{width:612,height:792,lines:[line("Projects",40)]}],plan);
  assert.ok(result.warnings.some(w=>w.includes("Expected one page; found 2")));
  assert.ok(result.warnings.some(w=>w.includes("bullet spanning 3 PDF lines")));
  assert.equal(result.workBulletLineCounts.length,6);
});
test("bullet mapping normalizes PDF ligatures",()=>{
  const plan=planFixture();
  const lines=[line("Example Candidate",40,130,480,16),line("Education",100),line("Technical Skills",200),line("Languages",220),line("Tools",234),line("Work Experience",300),...workBulletLines(330)];
  const target="Improving reliability and efficiency";
  plan.workExperience[0].bullets[0].text=target;
  lines[6]=line("Improving reliability and eﬀiciency",330);
  const result=inspectGeometry([{width:612,height:792,lines}],plan);
  assert.ok(!result.warnings.some(w=>w.includes("Could not map")),JSON.stringify(result.warnings));
});
test("Poppler XML is parsed and entities decoded",()=>{
  const pages=parseBoundingBoxes('<page width="612" height="792"><flow><block><line xMin="40" yMin="40" xMax="80" yMax="50"><word xMin="40">A &amp; B</word></line></block></flow></page>');
  assert.equal(pages[0].lines[0].text,"A & B");
});
