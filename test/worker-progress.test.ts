import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createWorkerProgress } from "../extensions/worker-progress.js";

test("streams worker progress, keeps completed responses, and cleans up the UI", async () => {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "apply-job-progress-"));
	const notices: string[] = [];
	let widget: string[] | undefined;
	let status: string | undefined;
	const ui = {
		notify: (message: string) => { notices.push(message); },
		setStatus: (_key: string, text: string | undefined) => { status = text; },
		setWidget: (_key: string, content: unknown) => { widget = content as string[] | undefined; },
	} as Pick<ExtensionUIContext, "notify" | "setStatus" | "setWidget">;
	const progress = createWorkerProgress(ui, folder, "Example — Engineer", "mtplx/example");
	// These are SDK event fixtures; unused usage/model fields are omitted.
	const emit = (event: unknown) => progress.onEvent(event as AgentSessionEvent);
	try {
		progress.phase("Drafting", "Waiting for model response");
		emit({ type: "turn_start" });
		emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
		await delay(250);
		assert.match(widget!.join("\n"), /Model is thinking/);
		assert.doesNotMatch(widget!.join("\n"), /private reasoning/);
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Selecting relevant experience." } });
		await delay(250);
		assert.match(widget!.join("\n"), /Selecting relevant experience/);
		assert.match(status!, /Drafting/);
		emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Selecting relevant experience.\nDraft ready." }] } });
		// Completed-message-only providers must also appear in chat and the log.
		emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Verified all selected evidence." }] } });
		emit({ type: "tool_execution_start", toolCallId: "1", toolName: "write", args: { path: `${folder}/resume-plan.json`, content: "Do not echo file contents" } });
		emit({ type: "tool_execution_end", toolCallId: "1", toolName: "write", isError: false, result: {} });
		emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "Connection reset" });
		await delay(250);
		assert.match(widget!.join("\n"), /1 model turns · 1 tool calls/);
		assert.match(widget!.join("\n"), /Provider retry 1\/3/);
		assert.ok(notices.some((text) => text.includes("Draft ready.")));
		assert.ok(notices.some((text) => text.includes("Verified all selected evidence.")));
		assert.ok(notices.some((text) => text.includes("write completed")));
		const verbose = `opening-${"x".repeat(12_000)}-closing`;
		emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: verbose }] } });
		const verboseNotice = [...notices].reverse().find(text => text.includes("opening-"))!;
		assert.ok(verboseNotice.length < 4_200, "completed response notifications must be bounded");
		assert.match(verboseNotice, /output truncated in UI/);
		assert.match(verboseNotice, /-closing/);
		const toolFailure = `broken-${"y".repeat(12_000)}-tool-end`;
		emit({ type: "tool_execution_end", toolCallId: "2", toolName: "submit_resume_draft", isError: true, result: toolFailure });
		const failureNotice = [...notices].reverse().find(text => text.includes("submit_resume_draft failed"))!;
		assert.ok(failureNotice.includes(toolFailure));
		assert.doesNotMatch(failureNotice, /output truncated in UI/);
		const log = fs.readFileSync(path.join(folder, "worker-output.log"), "utf8");
		assert.match(log, /Draft ready/);
		assert.match(log, /Verified all selected evidence/);
		assert.match(log, /resume-plan.json/);
		assert.ok(log.includes(toolFailure));
		assert.doesNotMatch(log, /Do not echo file contents|private reasoning/);
		assert.ok(fs.statSync(path.join(folder, "worker-output.log")).size < 4 * 1024 * 1024);
		progress.beginWorker("Fresh facts worker", "Bounded review");
		emit({ type: "turn_start" });
		await delay(250);
		assert.match(widget!.join("\n"), /Fresh facts worker · 0s elapsed · 1 model turns · 0 tool calls/);
		assert.match(widget!.join("\n"), /Application run total: \d+s elapsed/);
		assert.match(status!, /worker \d+s · total \d+s/);
		assert.doesNotMatch(widget!.join("\n"), /2 model turns|1 tool calls/);
		progress.dispose();
		assert.equal(widget, undefined);
		assert.equal(status, undefined);
		emit({ type: "turn_start" });
		await delay(250);
		assert.equal(widget, undefined);
	} finally {
		progress.dispose();
		fs.rmSync(folder, { recursive: true, force: true });
	}
});
