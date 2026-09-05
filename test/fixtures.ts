import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumePlan } from "../extensions/schemas.js";
import { createInitialMetadata, ensureWorkspace, saveMetadata, workspaceAt, writeJsonFile, writeTextFile } from "../extensions/utils.js";
export const master = `# [identity-01] Example Candidate
Software Systems

- [identity-02] Email: candidate@example.com
## Education
### [edu-01] Example University
B.S. Computer Science, GPA: 4.0/4.0
2021 - 2025 | City, ST
- [edu-02] Honors / Awards: Fellowship, Dean's List
- [edu-03] Completed courses: Algorithms, Systems
## Skills
- [skill-01] Languages: TypeScript, Python
- [skill-02] Tools: Git, Docker
## Work
### [role-01] Engineer at Example Company
2024 - 2025 | City, ST
- [role-02] Built a reliable service with automated regression tests.
- [role-03] Reduced validation latency by 50% through caching.
- [role-04] Coordinated releases with a three-person team.
### [project-01] Systems Project
2023
- [project-02] Built an isolated systems test harness in Python.
`;
export function planFixture(): ResumePlan {
  return { schemaVersion: 2, target: {company:"Example",role:"Engineer"},
    header:{name:"Example Candidate",headline:"Software Systems",contactLine:"candidate@example.com",evidence:["identity-01","identity-02"]},
    education:{institution:"Example University",degree:"B.S. Computer Science",gpa:"4.0/4.0",dates:"2021 - 2025",location:"City, ST",evidence:["edu-01"],honors:{items:["Fellowship","Dean's List"],evidence:["edu-02"]},coursework:{items:["Algorithms","Systems"],evidence:["edu-03"]}},
    skills:[{label:"Languages",value:"TypeScript, Python",evidence:["skill-01"]},{label:"Tools",value:"Git, Docker",evidence:["skill-02"]}],
    sections:[{title:"Work Experience",kind:"entries",entries:[{kind:"standard",title:"Engineer",subtitle:"Example Company",dates:"2024 - 2025",location:"City, ST",evidence:["role-01"],bullets:[{text:"Built a reliable service with automated regression tests.",evidence:["role-02"]},{text:"Reduced validation latency by 50% through caching.",evidence:["role-03"]}]}]},
      {title:"Projects",kind:"entries",entries:[{kind:"project",title:"Systems Project",dates:"2023",subtitle:"",location:"",evidence:["project-01"],bullets:[{text:"Built an isolated systems test harness in Python.",evidence:["project-02"]}]}]}] };
}
export const template = String.raw`\documentclass[letterpaper,10pt]{article}
\pagestyle{empty}
\setcounter{secnumdepth}{0}
\usepackage[margin=1.5cm]{geometry}
\usepackage{enumitem}
\newcommand{\resumeItem}[1]{\item\small{#1}}
\newcommand{\resumeSubheading}[4]{\item \textbf{#1} \hfill #2\\ \textit{#3} \hfill #4}
\newcommand{\resumeProjectHeading}[2]{\item \textbf{#1} \hfill #2}
\newcommand{\resumeItemListStart}{\begin{itemize}[leftmargin=0.15in]}
\newcommand{\resumeItemListEnd}{\end{itemize}}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0in,label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\begin{document}
%% PI:HEADER
%% PI:CONTENT
\end{document}`;
export function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"apply-job-test-"));
  const workspace = workspaceAt(path.join(root,"apply-job")); ensureWorkspace(workspace);
  const folder = path.join(workspace.jobsDir,"example","engineer"); fs.mkdirSync(folder,{recursive:true});
  writeTextFile(path.join(workspace.masterDir,"resume.md"),master);
  writeTextFile(path.join(workspace.templateDir,"resume-template.tex"),template);
  writeTextFile(path.join(folder,"job.md"),"# Example\nRequires Python and automated testing.\nGraduating in 2027.");
  writeJsonFile(path.join(folder,"job.json"),{company:"Example",role:"Engineer"});
  saveMetadata(folder,createInitialMetadata("https://example.com/jobs/1","Example","Engineer","092026"));
  function draft(plan=planFixture()) {
    writeJsonFile(path.join(folder,"resume-plan.json"),plan);
    writeTextFile(path.join(folder,"resume.md"),"# Example Candidate\nBuilt a reliable service with automated regression tests.");
    writeTextFile(path.join(folder,"analysis.md"),"# Requirement analysis");
    writeJsonFile(path.join(folder,"verification.json"),{approved:true,issues:[],summary:"Checked."});
  }
  return {root,workspace,folder,draft,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
