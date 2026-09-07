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

/** Pipeline state persisted so an interrupted run can be inspected or resumed. */
export type PipelineStage =
	| "scraped"
	| "analyzing"
	| "drafting"
	| "verifying"
	| "rendering"
	| "layout_verified"
	| "awaiting_approval"
	| "cover_letter_drafting"
	| "cover_letter_verifying"
	| "complete"
	| "failed";

/** A fact-backed plan that the deterministic renderer turns into a LaTeX resume. */
export interface ResumePlan {
	header: { name: string; headline: string; contactLine: string; evidence: string[] };
	education: {
		institution: string;
		degree: string;
		gpa: string;
		dates: string;
		location: string;
		evidence: string[];
		honors: { items: string[]; evidence: string[] };
		coursework: { items: string[]; evidence: string[] };
	};
	skills: Array<{ label: string; value: string; evidence: string[] }>;
	/** Rendered under the fixed "Professional Work Experience" heading; the array position is the only kind discriminator. */
	workExperience: Array<{
		title: string;
		dates: string;
		subtitle: string;
		location: string;
		bullets: Array<{ text: string; evidence: string[] }>;
		evidence: string[];
	}>;
	/** Rendered under the fixed "Projects" heading, only when non-empty. */
	projects: Array<{
		title: string;
		dates?: string;
		bullets: Array<{ text: string; evidence: string[] }>;
		evidence: string[];
	}>;
}

/** The only résumé-content choices the drafting worker must submit. */
export type ResumePlanInput = Pick<ResumePlan, "skills"> & {
	coursework: ResumePlan["education"]["coursework"];
	workExperience: Array<{ id: string; bullets: ResumePlan["workExperience"][number]["bullets"] }>;
	projects: Array<{ id: string; bullets: ResumePlan["projects"][number]["bullets"] }>;
};

/** True after the drafter tool materializes header/education from the master resume. */
export function isResumePlan(value: unknown): value is ResumePlan {
	if (!value || typeof value !== "object") return false;
	const plan = value as Partial<ResumePlan>;
	return Boolean(
		plan.header && typeof plan.header.name === "string" &&
		plan.education && Array.isArray(plan.education.coursework?.items) &&
		Array.isArray(plan.skills) &&
		Array.isArray(plan.workExperience) &&
		Array.isArray(plan.projects),
	);
}

/** Independent review record for the optional cover-letter workflow. */
export interface CoverLetterReview {
	approved: boolean;
	issues: Array<{
		claim: string;
		reason: string;
		suggestion: string;
	}>;
	summary: string;
	wordCount: number;
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
	schemaVersion: 3;
	url: string;
	company: string;
	role: string;
	scrapedAt: string;
	analyzedAt: string | null;
	tailoredAt: string | null;
	verifiedAt: string | null;
	completedAt: string | null;
	postedDate: string; // MMYYYY format
	revisionCount: number;
	stage: PipelineStage;
	lastError: string | null;
	layoutStatus: LayoutReport["templateStatus"];
	coverLetterStatus: "not_requested" | "drafting" | "verifying" | "approved" | "rejected";
	coverLetterRevisionCount: number;
	coverLetterVerifiedAt: string | null;
}
