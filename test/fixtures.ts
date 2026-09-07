import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumePlan, ResumePlanInput } from "../extensions/schemas.js";
import { createInitialMetadata, ensureWorkspace, saveMetadata, workspaceAt, writeJsonFile, writeTextFile } from "../extensions/utils.js";
export const master = `# [identity-01] Example Candidate
Software Systems

- [identity-02] Email: candidate@example.com
## Education
### [edu-01] Example University — City, ST
B.S. Computer Science, GPA: 4.0/4.0
2021 - 2025
- [edu-02] Honors / Awards: Fellowship, Dean's List
- [edu-03] Completed courses: Algorithms, Systems, Data Structures, Programming Abstractions, Theory of Computation, Software Development, Object-Oriented Programming
- [edu-04] Registered for next term (not yet completed): Compiler Design, Distributed Systems
## Skills
- [skill-01] Languages: TypeScript, Python
- [skill-02] Tools: Git, Docker
- [skill-03] Platforms: AWS, Linux
## Work Experience
### [role-01] Engineer at Example Company
2024 - 2025 | City, ST
- [role-02] Built a reliable service with automated regression tests.
- [role-03] Reduced validation latency by 50% through caching.
- [role-04] Coordinated releases with a three-person team.
### [role-05] Platform Engineer at Example Company
2023 - 2024 | City, ST
- [role-06] Built an API service with structured validation and retries.
- [role-07] Improved deployment reliability with containerized test environments.
- [role-11] Shipped typed request validation across the public API surface.
### [role-08] Research Assistant at Example University
2022 - 2023 | City, ST
- [role-09] Developed a concurrent data-processing experiment in Python.
- [role-10] Documented reproducible evaluation procedures for the research team.
## Projects
### [project-01] Systems Project
2023
- [project-02] Built an isolated systems test harness in Python with deterministic fixtures, crash recovery, and automated leak detection across mutated process inputs.
### [project-03] Service Project
2022
- [project-04] Built a typed API prototype with automated request validation, structured error handling, and regression tests covering authentication and retry paths.
`;
const workBullet = (text: string, evidence: string[]) => ({ text, evidence });
export function planFixture(): ResumePlan {
	return {
		header: { name: "Example Candidate", headline: "Software Systems", contactLine: "Email: candidate@example.com", evidence: ["identity-01", "identity-02"] },
		education: {
			institution: "Example University", degree: "B.S. Computer Science", gpa: "4.0/4.0", dates: "2021 - 2025", location: "City, ST",
			evidence: ["edu-01"], honors: { items: ["Fellowship", "Dean's List"], evidence: ["edu-02"] },
			coursework: { items: ["Data Structures", "Foundations of Computer Science", "Programming Abstractions", "Theory of Computation", "Systems Fundamentals I", "Software Development", "Object-Oriented Programming"], evidence: ["edu-03"] },
		},
		skills: [
			{ label: "Languages", value: "TypeScript, Python, Java", evidence: ["skill-01"] },
			{ label: "Tools", value: "Git, Docker, Linux", evidence: ["skill-02"] },
			{ label: "Platforms", value: "AWS, REST APIs, PostgreSQL", evidence: ["skill-03"] },
		],
		workExperience: [
			{ title: "Engineer", subtitle: "Example Company", dates: "2024 - 2025", location: "City, ST", evidence: ["role-01"], bullets: [
				workBullet("Reduced validation latency by 50% through caching while shipping automated regression tests for a production service used daily by the internal platform team.", ["role-02", "role-03"]),
				workBullet("Built a reliable request pipeline with structured error handling, deterministic fixtures, and documented recovery procedures for failed upstream calls.", ["role-02"]),
				workBullet("Coordinated releases with a three-person team and kept the public API stable across weekly deploys with typed validation at the boundary.", ["role-04"]),
			] },
			{ title: "Platform Engineer", subtitle: "Example Company", dates: "2023 - 2024", location: "City, ST", evidence: ["role-05"], bullets: [
				workBullet("Built an API service with structured validation, retries, and typed request envelopes so clients could recover cleanly from transient failures.", ["role-06"]),
				workBullet("Improved deployment reliability with containerized test environments and automated smoke checks before each production promotion.", ["role-07"]),
				workBullet("Shipped typed request validation across the public API surface and rejected malformed payloads before they reached downstream jobs.", ["role-11"]),
			] },
			{ title: "Research Assistant", subtitle: "Example University", dates: "2022 - 2023", location: "City, ST", evidence: ["role-08"], bullets: [
				workBullet("Developed a concurrent data-processing experiment in Python and measured throughput under contention on shared campus compute.", ["role-09"]),
				workBullet("Documented reproducible evaluation procedures so later students could rerun the experiment from a clean checkout.", ["role-10"]),
			] },
		],
		projects: [
			{ title: "Systems Project", dates: "2023", evidence: ["project-01"], bullets: [{ text: "Built an isolated systems test harness in Python with deterministic fixtures, crash recovery, and automated leak detection across mutated process inputs.", evidence: ["project-02"] }] },
			{ title: "Service Project", dates: "2022", evidence: ["project-03"], bullets: [{ text: "Built a typed API prototype with automated request validation, structured error handling, and regression tests covering authentication and retry paths.", evidence: ["project-04"] }] },
		],
	};
}
export function planSubmissionFixture(): ResumePlanInput {
	const plan = planFixture();
	return {
		coursework: plan.education.coursework,
		skills: plan.skills,
		workExperience: plan.workExperience.map(entry => ({ id: entry.evidence[0]!, bullets: entry.bullets })),
		projects: plan.projects.map(entry => ({ id: entry.evidence[0]!, bullets: entry.bullets })),
	};
}
export const template = String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage{tabularx}
\usepackage{fontawesome5}
\usepackage[margin=1.4cm]{geometry}
\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}
\addtolength{\oddsidemargin}{-0.15in}
\addtolength{\textwidth}{0.3in}
\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}
\titleformat{\section}{\vspace{-4pt}\scshape\raggedright\large\bfseries}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]
\newcommand{\resumeItem}[1]{\item\small{#1\vspace{-2pt}}}
\newcommand{\resumeSubheading}[4]{
  \vspace{-3pt}\item
  \begin{tabular*}{1.0\textwidth}[t]{l@{\extracolsep{\fill}}r}
    \textbf{#1} & \textbf{\small #2} \\
    \textit{\small #3} & \textit{\small #4} \\
  \end{tabular*}\vspace{-4pt}
}
\newcommand{\resumeProjectHeading}[2]{
  \vspace{-3pt}\item
  \begin{tabular*}{1.0\textwidth}{l@{\extracolsep{\fill}}r}
    \small #1 & \textbf{\small #2} \\
  \end{tabular*}\vspace{-4pt}
}
\newcommand{\resumeItemListStart}{\begin{itemize}\vspace{-3pt}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-6pt}}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}\vspace{-4pt}}
\begin{document}
%% PI:HEADER
%% PI:CONTENT
\end{document}`;
export function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-job-test-"));
	const workspace = workspaceAt(path.join(root, "apply-job")); ensureWorkspace(workspace);
	const folder = path.join(workspace.jobsDir, "example", "engineer"); fs.mkdirSync(folder, { recursive: true });
	writeTextFile(path.join(workspace.masterDir, "resume.md"), master);
	writeTextFile(path.join(workspace.templateDir, "resume-template.tex"), template);
	writeTextFile(path.join(folder, "job.md"), "# Example\nRequires Python and automated testing.\nGraduating in 2027.");
	saveMetadata(folder, createInitialMetadata("https://example.com/jobs/1", "Example", "Engineer", "092026"));
	function draft(plan = planFixture()) {
		writeJsonFile(path.join(folder, "resume-plan.json"), plan);
		writeTextFile(path.join(folder, "resume.md"), "# Example Candidate\nBuilt a reliable service with automated regression tests.");
	}
	return { root, workspace, folder, draft, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
