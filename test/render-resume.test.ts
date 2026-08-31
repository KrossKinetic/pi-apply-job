import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderResume } from "../extensions/render-resume.js";
import { createInitialMetadata, ensureWorkspace, getWorkspace, saveMetadata, writeJsonFile, writeTextFile } from "../extensions/utils.js";

const template = [
	"\\documentclass[letterpaper,10pt]{article}",
	"\\usepackage[margin=1.5cm]{geometry}",
	"\\usepackage{enumitem}",
	"\\newcommand{\\resumeItem}[1]{\\item\\small{#1}}",
	"\\newcommand{\\resumeSubheading}[4]{\\item \\textbf{#1} \\hfill #2\\\\ \\textit{#3} \\hfill #4}",
	"\\newcommand{\\resumeProjectHeading}[2]{\\item \\textbf{#1} \\hfill #2}",
	"\\newcommand{\\resumeItemListStart}{\\begin{itemize}[leftmargin=0.15in]}",
	"\\newcommand{\\resumeItemListEnd}{\\end{itemize}}",
	"\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0in,label={}]}",
	"\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}",
	"\\begin{document}",
	"%% PI:HEADER",
	"%% PI:CONTENT",
	"\\end{document}",
].join("\n");

test("renders an approved plan and rejects an unknown evidence ID", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apply-job-"));
	try {
		const workspace = getWorkspace(root);
		ensureWorkspace(workspace);
		writeTextFile(path.join(workspace.masterDir, "resume.md"), "# [identity-01] Candidate\\n- [role-01] Supported fact\\n");
		writeTextFile(path.join(workspace.templateDir, "resume-template.tex"), template);
		const folder = path.join(workspace.jobsDir, "company", "role-012026");
		fs.mkdirSync(folder, { recursive: true });
		saveMetadata(folder, createInitialMetadata("https://jobs.example.com/1", "Company", "Role", "012026"));
		writeJsonFile(path.join(folder, "verification.json"), { approved: true, issues: [], summary: "Approved." });
		writeJsonFile(path.join(folder, "resume-plan.json"), {
			schemaVersion: 1,
			target: { company: "Company", role: "Role" },
			header: { name: "Candidate", headline: "Engineer", contactLine: "candidate@example.com", evidence: ["identity-01"] },
			sections: [{
				title: "Experience",
				kind: "entries",
				entries: [{
					kind: "standard",
					title: "Engineer",
					dates: "2025 - Present",
					subtitle: "Company",
					location: "Remote",
					evidence: ["role-01"],
					bullets: [{ text: "Built a supported system.", evidence: ["role-01"] }],
				}],
			}],
		});
		const result = await renderResume(workspace, folder);
		assert.equal(result.passed, true);
		assert.equal(result.pageCount, 1);
		assert.equal(fs.existsSync(result.pdfPath), true);

		writeJsonFile(path.join(folder, "resume-plan.json"), {
			schemaVersion: 1,
			target: { company: "Company", role: "Role" },
			header: { name: "Candidate", headline: "Engineer", contactLine: "candidate@example.com", evidence: ["identity-01"] },
			sections: [{
				title: "Experience",
				kind: "entries",
				entries: [{
					kind: "standard",
					title: "Engineer",
					dates: "2025 - Present",
					subtitle: "Company",
					location: "Remote",
					evidence: ["invented-01"],
					bullets: [{ text: "Built a supported system.", evidence: ["invented-01"] }],
				}],
			}],
		});
		await assert.rejects(renderResume(workspace, folder), /unknown master-resume evidence ID\(s\): invented-01/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
