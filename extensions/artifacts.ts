/**
 * Stable on-disk artifacts used to keep reasoning, facts, and layout concerns
 * separate. The agent can edit the content artifacts, while TypeScript creates
 * their initial shape and preserves the original job source.
 */

import path from "path";
import type {
	JobPosting,
	LayoutReport,
	ScrapedJob,
	CoverLetterReview,
	VerificationResult,
} from "./schemas.js";
import { writeJsonFile } from "./utils.js";

const SECTION_HEADERS = /^(basic |minimum |preferred |desired |additional )?(qualifications|requirements|what you(?:'|’)ll need|what we(?:'|’)re looking for|skills|nice to have|bonus points)\b/i;
const LIST_ITEM = /^(?:[-*•]|\d+[.)])\s+(.+)/;

function lines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
}

function collectListAfterHeader(allLines: string[], headerMatcher: RegExp): string[] {
	const start = allLines.findIndex((line) => headerMatcher.test(line));
	if (start < 0) return [];
	const values: string[] = [];
	for (const line of allLines.slice(start + 1, start + 28)) {
		if (SECTION_HEADERS.test(line) && values.length > 0) break;
		const match = line.match(LIST_ITEM);
		if (match) values.push(match[1]);
		else if (values.length > 0 && line.length < 260) values.push(line);
	}
	return [...new Set(values)].slice(0, 20);
}

function inferLocation(allLines: string[]): string {
	for (let index = 0; index < allLines.length - 1; index += 1) {
		const inline = allLines[index].match(/^locations?\s*[:|-]\s*(.+)$/i);
		if (inline) return inline[1].trim();
		if (/^locations?$/i.test(allLines[index]) && allLines[index + 1].length < 140) {
			return allLines[index + 1];
		}
	}
	return "Not specified";
}

/** Normalize a scrape into a compact, reviewable job model. It deliberately does not infer facts. */
export function normalizeJobPosting(
	scraped: ScrapedJob,
	company: string,
	role: string,
	postedDate: string,
): JobPosting {
	const allLines = lines(scraped.body);
	const requirements = collectListAfterHeader(
		allLines,
		/^(basic |minimum )?(qualifications|requirements)|^what you(?:'|’)ll need|^what we(?:'|’)re looking for/i,
	);
	const niceToHave = collectListAfterHeader(
		allLines,
		/^(preferred |desired |additional )?(qualifications|requirements)|^nice to have|^bonus points/i,
	);
	return {
		schemaVersion: 1,
		url: scraped.url,
		company,
		role,
		title: scraped.title || role,
		description: scraped.description || "",
		requirements,
		niceToHave,
		location: inferLocation(allLines),
		postedDate,
		deadline: "Not specified",
		applyUrl: scraped.url,
	};
}

export function createResumePlanSkeleton(company: string, role: string): Record<string, unknown> {
	return {
		schemaVersion: 2,
		target: { company, role },
		header: { name: "", headline: "", contactLine: "", evidence: [] },
		education: {
			institution: "", degree: "", gpa: "", dates: "", location: "", evidence: [],
			honors: { items: [], evidence: [] },
			coursework: { items: [], evidence: [] },
		},
		skills: [],
		sections: [],
	};
}

export function createVerificationSkeleton(): VerificationResult {
	return { approved: false, issues: [], summary: "Not yet verified." };
}

export function createIndependentReviewSkeleton(summary: string): Record<string, unknown> {
	return { approved: false, issues: [], summary };
}

export function createCoverLetterReviewSkeleton(): CoverLetterReview {
	return { approved: false, issues: [], summary: "Not yet reviewed.", wordCount: 0 };
}

export function createLayoutSkeleton(): LayoutReport {
	return {
		templateStatus: "ready",
		compiler: null,
		pdfPath: null,
		pageCount: null,
		passed: null,
		warnings: [],
		checkedAt: null,
	};
}

/** Write all artifacts that establish the contract for the agent-driven stages. */
export function createPipelineArtifacts(
	folder: string,
	job: JobPosting,
	company: string,
	role: string,
): void {
	writeJsonFile(path.join(folder, "job.json"), job);
	writeJsonFile(path.join(folder, "resume-plan.json"), createResumePlanSkeleton(company, role));
	writeJsonFile(path.join(folder, "verification.json"), createVerificationSkeleton());
	writeJsonFile(path.join(folder, "independent-verification.json"), createIndependentReviewSkeleton("Not yet independently verified."));
	writeJsonFile(path.join(folder, "quality-review.json"), createIndependentReviewSkeleton("Not yet quality reviewed."));
	writeJsonFile(path.join(folder, "layout.json"), createLayoutSkeleton());
}
