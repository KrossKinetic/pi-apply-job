import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type ProgressUI = Pick<ExtensionUIContext, "notify" | "setWidget" | "setStatus">;

function plain(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** UI-only reporting: worker output never enters the parent model's context. */
export function createWorkerProgress(ui: ProgressUI, folder: string, label: string, model: string) {
	const key = "apply-job-worker";
	const transcript = path.join(folder, "worker-output.log");
	const started = Date.now();
	let lastEvent = started;
	let stage = "Initializing worker session";
	let activity = "Loading worker resources";
	let response = "";
	let turns = 0;
	let tools = 0;
	let generatedCharacters = 0;
	let logFailed = false;
	let disposed = false;
	let dirty = true;
	let lastRender = 0;

	function record(text: string) {
		if (logFailed) return;
		try {
			fs.appendFileSync(transcript, `[${new Date().toISOString()}] ${plain(text)}\n\n`, { mode: 0o600 });
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
		const silence = Math.floor((now - lastEvent) / 1_000);
		ui.setStatus(key, `Résumé: ${plain(stage)} · ${elapsed}s`);
		ui.setWidget(key, [
			`Résumé worker: ${plain(label)}`,
			`Model: ${plain(model)}`,
			`${plain(stage)} · ${elapsed}s elapsed · ${turns} model turns · ${tools} tool calls`,
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
					ui.notify(`Résumé worker — ${plain(label)}\n${plain(text)}`, "info");
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
			case "tool_execution_end":
				activity = `${event.toolName} ${event.isError ? "failed" : "completed"}`;
				record(activity);
				ui.notify(`Résumé worker: ${plain(activity)}`, event.isError ? "warning" : "info");
				break;
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
