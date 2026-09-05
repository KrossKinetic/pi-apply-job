/** Filesystem helpers and user-wide Pi workspace management. */

import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JobMetadata, PipelineStage } from "./schemas.js";

export interface ApplyJobWorkspace {
	rootDir: string;
	jobsDir: string;
	masterDir: string;
	templateDir: string;
	coverLetterDir: string;
}

/** Build a workspace from an explicit root. Intended for tests. */
export function workspaceAt(root: string): ApplyJobWorkspace {
	const rootDir = path.resolve(root);
	return {
		rootDir,
		jobsDir: path.join(rootDir, "jobs"),
		masterDir: path.join(rootDir, "master"),
		templateDir: path.join(rootDir, "master", "template"),
		coverLetterDir: path.join(rootDir, "master", "cover-letter"),
	};
}

/**
 * Personal resume data and generated applications live beside Pi's agent
 * state, never in the extension package or the caller's project.
 */
export function getWorkspace(): ApplyJobWorkspace {
	return workspaceAt(path.join(path.dirname(getAgentDir()), "apply-job"));
}

export function ensureWorkspace(workspace: ApplyJobWorkspace): void {
	fs.mkdirSync(workspace.jobsDir, { recursive: true });
	fs.mkdirSync(workspace.templateDir, { recursive: true });
	fs.mkdirSync(workspace.coverLetterDir, { recursive: true });
}

export function masterFilePath(
	workspace: ApplyJobWorkspace,
	name: "resume.md",
): string {
	return path.join(workspace.masterDir, name);
}

export function templateFilePath(workspace: ApplyJobWorkspace): string {
	return path.join(workspace.templateDir, "resume-template.tex");
}

/** Return the readable writing samples and background notes available to a cover-letter worker. */
export function coverLetterSourceFiles(workspace: ApplyJobWorkspace): string[] {
	const allowedExtensions = new Set([".md", ".txt"]);
	const sources: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) sources.push(entryPath);
		}
	};
	if (fs.existsSync(workspace.coverLetterDir)) visit(workspace.coverLetterDir);
	return sources.sort();
}

export function missingSourceFiles(workspace: ApplyJobWorkspace, requireCoverLetterSources = false): string[] {
	const sources = [
		{ label: "master/resume.md", path: masterFilePath(workspace, "resume.md") },
		{ label: "master/template/resume-template.tex", path: templateFilePath(workspace) },
	];
	const missing = sources.filter((source) => !fs.existsSync(source.path)).map((source) => source.label);
	if (requireCoverLetterSources && coverLetterSourceFiles(workspace).length === 0) {
		missing.push("at least one Markdown or text source in master/cover-letter/");
	}
	return missing;
}

export function sanitizeFolderName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 96);
	return slug || "unknown";
}

export function buildJobFolder(
	workspace: ApplyJobWorkspace,
	company: string,
	role: string,
	postedDate: string,
): string {
	return path.join(
		workspace.jobsDir,
		sanitizeFolderName(company),
		`${sanitizeFolderName(role)}-${postedDate}`,
	);
}

/** Create a new application folder without overwriting an earlier run. */
export function ensureJobFolder(
	workspace: ApplyJobWorkspace,
	company: string,
	role: string,
	postedDate: string,
): string {
	const baseFolder = buildJobFolder(workspace, company, role, postedDate);
	fs.mkdirSync(path.dirname(baseFolder), { recursive: true });
	for (let suffix = 1; ; suffix += 1) {
		const folder = suffix === 1 ? baseFolder : `${baseFolder}-${suffix}`;
		try {
			fs.mkdirSync(folder);
			return folder;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
				throw error;
			}
		}
	}
}

export function readTextFile(filePath: string): string {
	return fs.readFileSync(filePath, "utf8");
}

/** Atomically replace a text artifact so interrupted writes cannot corrupt it. */
export function writeTextFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporaryPath, content, "utf8");
	fs.renameSync(temporaryPath, filePath);
}

export function writeJsonFile(filePath: string, data: unknown): void {
	writeTextFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJsonFile<T>(filePath: string): T {
	try {
		return JSON.parse(readTextFile(filePath)) as T;
	} catch (error) {
		throw new Error(`Failed to parse JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function nowISO(): string {
	return new Date().toISOString();
}

export function createInitialMetadata(
	url: string,
	company: string,
	role: string,
	postedDate: string,
): JobMetadata {
	return {
		schemaVersion: 3,
		url,
		company,
		role,
		scrapedAt: nowISO(),
		analyzedAt: null,
		tailoredAt: null,
		verifiedAt: null,
		completedAt: null,
		postedDate,
		fitScore: null,
		verificationStatus: "pending",
		revisionCount: 0,
		stage: "scraped",
		lastError: null,
		layoutStatus: "not_configured",
		coverLetterStatus: "not_requested",
		coverLetterRevisionCount: 0,
		coverLetterVerifiedAt: null,
	};
}

export function saveMetadata(folder: string, metadata: JobMetadata): void {
	writeJsonFile(path.join(folder, "metadata.json"), metadata);
}

export function updateMetadata(folder: string, changes: Partial<JobMetadata>): JobMetadata {
	const current = readJsonFile<JobMetadata>(path.join(folder, "metadata.json"));
	const next = { ...current, ...changes };
	saveMetadata(folder, next);
	return next;
}

export function markPipelineFailed(folder: string, error: string): JobMetadata {
	return updateMetadata(folder, { stage: "failed" as PipelineStage, lastError: error });
}
