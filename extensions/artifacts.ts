/**
 * Stable on-disk artifacts used to keep reasoning, facts, and layout concerns
 * separate. Workers submit typed values; coordinator-owned TypeScript is the
 * only code that creates or updates on-disk artifacts.
 */

import path from "path";
import type {
	LayoutReport,
} from "./schemas.js";
import { writeJsonFile } from "./utils.js";

function createResumePlanSkeleton(): Record<string, unknown> {
	return {
		coursework: { items: [], evidence: [] },
		skills: [],
		workExperience: [],
		projects: [],
	};
}

function createIndependentReviewSkeleton(summary: string): Record<string, unknown> {
	return { approved: false, issues: [], summary };
}

function createLayoutSkeleton(): LayoutReport {
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
): void {
	writeJsonFile(path.join(folder, "resume-plan.json"), createResumePlanSkeleton());
	writeJsonFile(path.join(folder, "independent-verification.json"), createIndependentReviewSkeleton("Not yet independently verified."));
	writeJsonFile(path.join(folder, "layout.json"), createLayoutSkeleton());
}
