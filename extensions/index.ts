/**
 * Job Agent Extension
 *
 * Registers `/apply-job [--cover-letter] <url>`:
 *   URL → scrape → create job folder → tailor and verify resume → optional cover letter → save
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadPythonTools } from "./python-tools.js";
import { resumePipeline, runBatchPipeline, runPipeline } from "./workflow.js";
import { ensureWorkspace, getWorkspace, masterFilePath, templateFilePath } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BATCH_URLS = 25;
const MAX_URL_FILE_BYTES = 64 * 1024;

function isNonPublicIpLiteral(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const version = isIP(host);
	if (version === 4) {
		const [a, b] = host.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
			(a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0);
	}
	if (version === 6) {
		return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
			host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") ||
			host.startsWith("ff") || host.startsWith("2001:db8:") || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.");
	}
	return false;
}

export function isPublicHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
		return Boolean(
			host &&
			["http:", "https:"].includes(parsed.protocol) &&
			!parsed.username &&
			!parsed.password &&
			host !== "localhost" &&
			!host.endsWith(".localhost") &&
			!host.endsWith(".local") &&
			!isNonPublicIpLiteral(host),
		);
	} catch {
		return false;
	}
}

/** Accept comma-separated lists as requested, plus one URL per line or semicolons. */
function parseUrlList(content: string): { urls: string[]; invalid: string[] } {
	const entries = content
		.split(/[;,\r\n]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry && !entry.startsWith("#"));
	const invalid = entries.filter((entry) => !isPublicHttpUrl(entry));
	return { urls: [...new Set(entries.filter((entry) => isPublicHttpUrl(entry)))], invalid };
}

function parseApplyJobArgs(args: string): { url: string | null; coverLetter: boolean; error: string | null } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let coverLetter = false;
	const urls: string[] = [];
	for (const token of tokens) {
		if (token === "--cover-letter") {
			coverLetter = true;
			continue;
		}
		if (token.startsWith("--")) return { url: null, coverLetter, error: `Unknown option: ${token}` };
		urls.push(token);
	}
	if (urls.length !== 1) return { url: null, coverLetter, error: "Provide exactly one job-posting URL." };
	return { url: urls[0], coverLetter, error: null };
}

export default function (pi: ExtensionAPI) {
	const toolsDir = path.join(__dirname, "tools");
	pi.registerCommand("apply-job-revise", {
		description: "Request a targeted revision, including after a revision limit: <folder> :: <feedback>",
		handler: async (args: string, ctx) => {
			if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current task to finish.", "warning"); return; }
			const split = args.indexOf(" :: ");
			if (split < 1 || !args.slice(split + 4).trim()) { ctx.ui.notify("Usage: /apply-job-revise <folder> :: <feedback>", "error"); return; }
			const folder = args.slice(0, split).trim().replace(/^"(.*)"$/, "$1");
			try {
				const result = await resumePipeline(path.resolve(ctx.cwd, folder), ctx, args.slice(split + 4).trim());
				if (result.error) ctx.ui.notify(result.error, "error");
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});
	for (const command of ["apply-job-resume", "apply-job-review"]) {
		pi.registerCommand(command, {
			description: "Resume an existing job from validated checkpoints and review its PDF",
			handler: async (args: string, ctx) => {
				if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current task to finish.", "warning"); return; }
				const folder = args.trim().replace(/^"(.*)"$/, "$1");
				if (!folder) { ctx.ui.notify(`Usage: /${command} <existing-job-folder>`, "error"); return; }
				try {
					const result = await resumePipeline(path.resolve(ctx.cwd, folder), ctx);
					ctx.ui.notify(result.completed ? "Approved résumé complete." : result.awaitingApproval ? "Saved for your review." : result.error || "Resume stopped.", result.error ? "error" : "info");
				} catch (error) { ctx.ui.notify(String(error), "error"); }
			},
		});
	}

	pi.registerCommand("apply-job-init", {
		description: "Create the user-wide private Pi workspace used by pi-apply-job",
		handler: async (_args: string, ctx) => {
			const workspace = getWorkspace();
			ensureWorkspace(workspace);
			ctx.ui.notify(
				`Workspace ready. Add the private master resume at ${masterFilePath(workspace, "resume.md")}, the formatting template at ${templateFilePath(workspace)}, and optional cover-letter samples at ${workspace.coverLetterDir}.`,
				"info",
			);
		},
	});

	pi.registerCommand("apply-job-file", {
		description: "Process public job URLs from a comma- or newline-separated text file",
		handler: async (args: string, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy. Run /apply-job-file after the current turn finishes.", "warning");
				return;
			}
			const argument = args.trim();
			if (!argument) {
				ctx.ui.notify("Usage: /apply-job-file <path-to-url-list.txt>", "error");
				return;
			}
			const filePath = path.resolve(ctx.cwd, argument);
			try {
				const stat = fs.statSync(filePath);
				if (!stat.isFile()) throw new Error("Path is not a regular file");
				if (stat.size > MAX_URL_FILE_BYTES) throw new Error(`URL file exceeds the ${MAX_URL_FILE_BYTES / 1024} KB limit`);
				const { urls, invalid } = parseUrlList(fs.readFileSync(filePath, "utf8"));
				if (invalid.length > 0) throw new Error(`Invalid or non-public URL entries: ${invalid.slice(0, 3).join(", ")}`);
				if (urls.length === 0) throw new Error("The file did not contain any job URLs");
				if (urls.length > MAX_BATCH_URLS) throw new Error(`The file contains ${urls.length} URLs; the batch limit is ${MAX_BATCH_URLS}`);

				const result = await runBatchPipeline(urls, ctx, toolsDir, loadPythonTools);
				if (result.awaitingApproval.length) ctx.ui.notify(`${result.awaitingApproval.length} jobs are saved and awaiting your review. Use /apply-job-review <folder>.`, "info");
				if (result.failed.length > 0) {
					ctx.ui.notify(`Completed ${result.completed}/${urls.length} jobs with isolated workers. ${result.failed.length} failed during preparation or tailoring.`, "warning");
				} else {
					ctx.ui.notify(`Approved ${result.completed}/${urls.length} jobs; ${result.awaitingApproval.length} awaiting review.`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Batch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// Register the /apply-job command
	pi.registerCommand("apply-job", {
		description: "Run the job application pipeline: /apply-job [--cover-letter] <url>",
		handler: async (args: string, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy. Run /apply-job after the current turn finishes.", "warning");
				return;
			}
			const parsed = parseApplyJobArgs(args);
			if (parsed.error || !parsed.url) {
				ctx.ui.notify(`Usage: /apply-job [--cover-letter] <url>${parsed.error ? ` (${parsed.error})` : ""}`, "error");
				return;
			}
			if (!isPublicHttpUrl(parsed.url)) {
				ctx.ui.notify("Usage: /apply-job [--cover-letter] <valid http(s) job-posting URL>", "error");
				return;
			}

			try {
				await runPipeline(parsed.url, ctx, toolsDir, loadPythonTools, { coverLetter: parsed.coverLetter });
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Pipeline failed: ${errMsg}`, "error");
			}
		},
	});
}
