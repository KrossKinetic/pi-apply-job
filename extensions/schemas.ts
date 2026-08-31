/**
 * Schemas for the Job Agent pipeline.
 *
 * All data structures used across scraping, analysis, tailoring,
 * and verification steps.
 */

/** Raw data returned by the Playwright URL scraper. */
export interface ScrapedJob {
	url: string;
	title: string | null;
	heading: string | null;
	description: string | null;
	body: string;
	status?: "success" | "timeout" | "error";
	statusCode?: number;
	error: string | null;
}

/** Parsed job posting stored as job.md source. */
export interface JobPosting {
	schemaVersion: 1;
	url: string;
	company: string;
	role: string;
	title: string;
	description: string;
	requirements: string[];
	niceToHave: string[];
	location: string;
	postedDate: string;
	deadline: string;
	applyUrl: string;
}

/** Pipeline state persisted so an interrupted run can be inspected or resumed. */
export type PipelineStage =
	| "scraped"
	| "analyzing"
	| "drafting"
	| "verifying"
	| "rendering"
	| "layout_verified"
	| "complete"
	| "failed";

/** A fact-backed plan that the deterministic renderer turns into a LaTeX resume. */
export interface ResumePlan {
	schemaVersion: 1;
	target: { company: string; role: string };
	header: { name: string; headline: string; contactLine: string; evidence: string[] };
	sections: Array<{
		title: string;
		kind: "entries" | "skills";
		entries?: Array<{
			kind?: "standard" | "project";
			title: string;
			dates?: string;
			subtitle?: string;
			location?: string;
			bullets: Array<{ text: string; evidence: string[] }>;
			evidence: string[];
		}>;
		skills?: Array<{ label: string; value: string; evidence: string[] }>;
	}>;
}

/** Structured analysis produced by the Job Analyzer agent. */
export interface JobAnalysis {
	fitScore: number;
	strengths: string[];
	weaknesses: string[];
	explicitMatches: string[];
	implicitSkills: Array<{
		skill: string;
		evidence: string;
	}>;
	missingRequirements: string[];
	resumeRecommendations: string[];
}

/** Verification result from the Resume Verifier agent. */
export interface VerificationResult {
	approved: boolean;
	issues: Array<{
		claim: string;
		reason: string;
	}>;
	summary: string;
}

/** The result of compiling and visually checking a template-generated PDF. */
export interface LayoutReport {
	templateStatus: "not_configured" | "ready" | "passed" | "failed";
	compiler: string | null;
	pdfPath: string | null;
	pageCount: number | null;
	passed: boolean | null;
	warnings: string[];
	checkedAt: string | null;
}

/** Top-level metadata persisted as metadata.json. */
export interface JobMetadata {
	schemaVersion: 2;
	url: string;
	company: string;
	role: string;
	scrapedAt: string;
	analyzedAt: string | null;
	tailoredAt: string | null;
	verifiedAt: string | null;
	completedAt: string | null;
	postedDate: string; // MMYYYY format
	fitScore: number | null;
	verificationStatus: "pending" | "approved" | "rejected";
	revisionCount: number;
	stage: PipelineStage;
	lastError: string | null;
	layoutStatus: LayoutReport["templateStatus"];
}
