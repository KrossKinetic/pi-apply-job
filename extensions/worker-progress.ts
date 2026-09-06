import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type ProgressUI = Pick<ExtensionUIContext, "notify" | "setWidget" | "setStatus">;
const MAX_NOTICE_CHARS = 4_000;
const MAX_LOG_RECORD_CHARS = 40_000;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

function plain(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function excerpt(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	const side = Math.floor((maximum - 48) / 2);
	return `${value.slice(0, side)}\n… output truncated in UI …\n${value.slice(-side)}`;
}

/** Extract the human-readable reason returned by a failed worker tool call. */
function toolFailureDetail(result: unknown): string {
	if (typeof result === "string") return result;
	if (result instanceof Error) return result.message;
	if (!result || typeof result !== "object") return "No error detail was returned.";
	const value = result as Record<string, unknown>;
	for (const key of ["error", "errorMessage", "message"]) {
		if (typeof value[key] === "string" && value[key].trim()) return value[key];
	}
	if (Array.isArray(value.content)) {
		const text = value.content
			.filter((block): block is { type: "text"; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
			.map(block => block.text)
			.filter(Boolean)
			.join("\n");
		if (text) return text;
	}
	return "No error detail was returned.";
}

/** UI-only reporting: worker output never enters the parent model's context. */
export function createWorkerProgress(ui: ProgressUI, folder: string, label: string, model: string) {
	const key = "apply-job-worker";
	const transcript = path.join(folder, "worker-output.log");
	const runStarted = Date.now();
	let started = Date.now();
	let lastEvent = started;
	let stage = "Initializing worker session";
	let activity = "Loading worker resources";
	let response = "";
	let turns = 0;
	let tools = 0;
	let generatedCharacters = 0;
	let logFailed = false;
	let logCapped = false;
	let loggedBytes = fs.existsSync(transcript) ? fs.statSync(transcript).size : 0;
	let disposed = false;
	let dirty = true;
	let lastRender = 0;
	if (fs.existsSync(transcript)) fs.chmodSync(transcript, 0o600);

	function record(text: string, maximum = MAX_LOG_RECORD_CHARS) {
		if (logFailed || logCapped) return;
		try {
			const bounded = maximum === Number.POSITIVE_INFINITY ? plain(text) : excerpt(plain(text), maximum);
			const entry = `[${new Date().toISOString()}] ${bounded}\n\n`;
			const bytes = Buffer.byteLength(entry);
			if (loggedBytes + bytes > MAX_LOG_BYTES) {
				logCapped = true;
				ui.notify(`Worker transcript reached its ${MAX_LOG_BYTES / 1024 / 1024} MB safety cap. Live progress remains available.`, "warning");
				return;
			}
			fs.appendFileSync(transcript, entry, { mode: 0o600 });
			loggedBytes += bytes;
		} catch {
			logFailed = true;
			ui.notify(`Could not save worker output to ${transcript}. Live progress remains available.`, "warning");
		}
	}

	function refresh() {
		const now = Date.now();
		if (disposed || (!dirty && now - lastRender < 1_000)) return;
		dirty = false;
		lastRender = now;
		const elapsed = Math.floor((now - started) / 1_000);
		const runElapsed = Math.floor((now - runStarted) / 1_000);
		const silence = Math.floor((now - lastEvent) / 1_000);
		ui.setStatus(key, `Résumé: ${plain(stage)} · worker ${elapsed}s · total ${runElapsed}s`);
		ui.setWidget(key, [
			`Résumé worker: ${plain(label)}`,
			`Model: ${plain(model)}`,
			`${plain(stage)} · ${elapsed}s elapsed · ${turns} model turns · ${tools} tool calls`,
			`Application run total: ${runElapsed}s elapsed`,
			`${plain(activity)} · last event ${silence}s ago · ${generatedCharacters} streamed characters`,
			...(response ? ["Latest response (live):", ...plain(response.slice(-1_200)).split("\n").slice(-6)] : []),
			`Full responses and activity: ${transcript}`,
		]);
	}

	function phase(nextStage: string, detail: string) {
		if (disposed) return;
		stage = nextStage;
		activity = detail;
		lastEvent = Date.now();
		dirty = true;
		record(`${stage}: ${detail}`);
		refresh();
	}

	/** Start a fresh measurement window for each isolated worker session. */
	function beginWorker(nextStage: string, detail: string) {
		if (disposed) return;
		started = Date.now();
		lastEvent = started;
		stage = nextStage;
		activity = detail;
		response = "";
		turns = 0;
		tools = 0;
		generatedCharacters = 0;
		dirty = true;
		record(`Worker measurement started: ${stage}\n${detail}`);
		refresh();
	}

	function onEvent(event: AgentSessionEvent) {
		if (disposed) return;
		lastEvent = Date.now();
		dirty = true;
		switch (event.type) {
			case "turn_start":
				turns += 1;
				response = "";
				activity = "Waiting for model response";
				record(`Model turn ${turns} started`);
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent;
				if (delta.type === "text_delta") {
					response = (response + delta.delta).slice(-1_200);
					generatedCharacters += delta.delta.length;
					activity = "Generating response";
				} else if (delta.type === "thinking_delta") {
					generatedCharacters += delta.delta.length;
					activity = "Model is thinking";
				} else if (delta.type === "toolcall_delta") {
					generatedCharacters += delta.delta.length;
					activity = "Preparing tool arguments";
				}
				break;
			}
			case "message_end": {
				if (event.message.role !== "assistant") break;
				// Completed messages also cover providers that don't stream deltas.
				const text = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				if (text.trim()) {
					response = text;
					record(`Worker response:\n${text}`);
					ui.notify(`Résumé worker — ${plain(label)}\n${excerpt(plain(text), MAX_NOTICE_CHARS)}`, "info");
				}
				activity = `Model response ended (${event.message.stopReason})`;
				if (event.message.errorMessage) {
					activity = `Model error: ${event.message.errorMessage}`;
					record(activity);
					ui.notify(plain(activity), "error");
				}
				break;
			}
			case "tool_execution_start": {
				tools += 1;
				const args = event.args;
				const file = args && typeof args.path === "string" ? args.path : "";
				activity = `Running ${event.toolName}${file ? `: ${file}` : ""}`;
				record(activity);
				ui.notify(`Résumé worker: ${plain(activity)}`, "info");
				break;
			}
			case "tool_execution_end": {
				const detail = event.isError ? `: ${toolFailureDetail(event.result)}` : "";
				const summary = `${event.toolName} ${event.isError ? "failed" : "completed"}`;
				activity = `${summary}${event.isError ? " — see notification and worker-output.log" : ""}`;
				record(`${summary}${detail}`, event.isError ? Number.POSITIVE_INFINITY : MAX_LOG_RECORD_CHARS);
				ui.notify(`Résumé worker: ${event.isError ? plain(`${summary}${detail}`) : excerpt(plain(`${summary}${detail}`), MAX_NOTICE_CHARS)}`, event.isError ? "warning" : "info");
				break;
			}
			case "auto_retry_start":
				activity = `Provider retry ${event.attempt}/${event.maxAttempts} in ${Math.ceil(event.delayMs / 1_000)}s: ${event.errorMessage}`;
				record(activity);
				ui.notify(plain(activity), "warning");
				break;
			case "compaction_start":
				activity = "Compacting worker context";
				record(activity);
				break;
			case "compaction_end":
				activity = event.errorMessage ? `Compaction failed: ${event.errorMessage}` : "Compaction finished";
				record(activity);
				break;
		}
	}

	record(`Worker: ${label}\nModel: ${model}`);
	refresh();
	// This timer refreshes the display only; it never stops the model.
	const timer = setInterval(refresh, 200);
	timer.unref();
	return {
		onEvent,
		phase,
		beginWorker,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(timer);
			record("Worker session closed");
			ui.setWidget(key, undefined);
			ui.setStatus(key, undefined);
		},
	};
}
