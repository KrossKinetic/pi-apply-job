/**
 * Job Agent Extension
 *
 * Registers the `/apply-job <url>` command which runs the full pipeline:
 *   URL → scrape → create job folder → analyze → tailor resume → verify → save
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadPythonTools } from "./python-tools.js";
import { runBatchPipeline, runPipeline } from "./workflow.js";
import { renderResume } from "./render-resume.js";
import { ensureWorkspace, getWorkspace, masterFilePath, templateFilePath } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BATCH_URLS = 25;
const MAX_URL_FILE_BYTES = 64 * 1024;

function isPublicHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		const host = parsed.hostname.toLowerCase();
		return Boolean(
			host &&
			["http:", "https:"].includes(parsed.protocol) &&
			!parsed.username &&
			!parsed.password &&
			host !== "localhost" &&
			!host.endsWith(".localhost") &&
			!host.endsWith(".local"),
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

export default function (pi: ExtensionAPI) {
	const toolsDir = path.join(__dirname, "tools");

	pi.registerTool({
		name: "apply_job_render_resume",
		label: "Render tailored resume",
		description: "Render a verified resume-plan.json with the configured LaTeX template and return its PDF page count. Use only after factual verification; revise the plan rather than the template when the result exceeds one page.",
		parameters: Type.Object({
			jobFolder: Type.String({ description: "Absolute path to this application's job folder" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await renderResume(getWorkspace(ctx.cwd), params.jobFolder);
				return {
					content: [{ type: "text", text: "Rendered " + result.pdfPath + ": " + result.pageCount + " page(s), " + (result.passed ? "passed" : "needs a shorter plan") + "." }],
					details: result,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Resume rendering failed: " + (error instanceof Error ? error.message : String(error)) }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("apply-job-init", {
		description: "Create the project-local private workspace used by pi-apply-job",
		handler: async (_args: string, ctx) => {
			const workspace = getWorkspace(ctx.cwd);
			ensureWorkspace(workspace);
			ctx.ui.notify(
				`Workspace ready. Add the private master resume at ${masterFilePath(workspace, "resume.md")} and the formatting template at ${templateFilePath(workspace)}.`,
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

				const result = await runBatchPipeline(urls, ctx, toolsDir, loadPythonTools, ctx.cwd);
				if (result.failed.length > 0) {
					ctx.ui.notify(`Completed ${result.completed}/${urls.length} jobs with isolated workers. ${result.failed.length} failed during preparation or tailoring.`, "warning");
				} else {
					ctx.ui.notify(`Completed ${result.completed}/${urls.length} jobs with one isolated worker per application.`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Batch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// Register the /apply-job command
	pi.registerCommand("apply-job", {
		description: "Run the full job application pipeline: /apply-job <url>",
		handler: async (args: string, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy. Run /apply-job after the current turn finishes.", "warning");
				return;
			}
			const url = args.trim();
			if (!url) {
				ctx.ui.notify("Usage: /apply-job <url>", "error");
				return;
			}
			if (!isPublicHttpUrl(url)) {
				ctx.ui.notify("Usage: /apply-job <valid http(s) job-posting URL>", "error");
				return;
			}

			try {
				await runPipeline(url, ctx, toolsDir, loadPythonTools, ctx.cwd);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Pipeline failed: ${errMsg}`, "error");
			}
		},
	});
}
