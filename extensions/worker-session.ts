import { createAgentSession, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { createWorkerReadTool, createWorkerSubmissionTool, type SubmissionContext, type WorkerSubmissionKind } from "./worker-submissions.js";

/** Pi's tools option allowlists ALL tools, including SDK custom tools. */
export async function createSubmissionWorkerSession(
	options: Omit<CreateAgentSessionOptions, "tools" | "customTools" | "noTools" | "excludeTools">,
	kind: WorkerSubmissionKind,
	context: SubmissionContext,
) {
	const submission = createWorkerSubmissionTool(kind, context);
	const reader = createWorkerReadTool(kind, context);
	const customTools = [reader, submission.tool];
	const tools = customTools.map(tool => tool.name);
	const result = await createAgentSession({ ...options, tools, customTools });
	const active = result.session.getActiveToolNames();
	if (active.length !== tools.length || tools.some(name => !active.includes(name))) {
		result.session.dispose();
		throw new Error(`Worker tool setup failed: expected ${tools.join(", ")}; active tools: ${active.join(", ") || "none"}`);
	}
	return { ...result, consumeSubmission: submission.consume };
}
