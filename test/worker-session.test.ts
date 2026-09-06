import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSubmissionWorkerSession } from "../extensions/worker-session.js";
import { submissionToolName, type WorkerSubmissionKind } from "../extensions/worker-submissions.js";
import { setup } from "./fixtures.js";

test("real SDK worker sessions expose only the reader and role submission, and execute both", async () => {
	const f = setup();
	try {
		const agentDir = path.join(f.root, "agent");
		const settingsManager = SettingsManager.inMemory();
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
			modelsStorePath: path.join(agentDir, "models-store.json"),
			refreshOnCreate: false,
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: f.root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [pi => {
				pi.registerTool({ name: "unrelated_provider_tool", label: "Unrelated", description: "Must remain unavailable", parameters: Type.Object({}),
					execute: async () => { throw new Error("Unrelated tool must never execute"); } });
			}],
		});
		await resourceLoader.reload();
		const kinds: WorkerSubmissionKind[] = ["requirements", "resume_draft", "facts_review", "targeted_patch", "cover_letter", "cover_letter_review"];
		for (const kind of kinds) {
			const result = await createSubmissionWorkerSession({
				cwd: f.root, agentDir, resourceLoader, settingsManager, modelRuntime,
				sessionManager: SessionManager.inMemory(f.root),
			}, kind, { folder: f.folder, workspace: f.workspace, company: "Example", role: "Engineer" });
			try {
				const expected = ["read_pipeline_file", submissionToolName(kind)].sort();
				assert.deepEqual(result.session.getActiveToolNames().sort(), expected, kind);
				// These are the actual tools exposed in the agent's model context, not just definitions.
				const tools = result.session.agent.state.tools;
				assert.deepEqual(tools.map(tool => tool.name).sort(), expected, kind);
				if (kind === "requirements") {
					const read = await tools.find(tool => tool.name === "read_pipeline_file")!.execute("read-1", { path: path.join(f.folder, "job.md") });
					assert.match(JSON.stringify(read.content), /Requires Python and automated testing/);
					const payload = {
						schemaVersion: 1,
						job: { company: "Example", role: "Example", roleQuote: "Example" },
						summary: { text: "Python and automated testing are required.", quotes: ["Requires Python and automated testing."] },
						details: [],
						requirements: [{ id: "R1", text: "Python and testing", quote: "Requires Python and automated testing.", importance: "core" }],
						skills: [{ name: "Python", quote: "Requires Python and automated testing.", importance: "core" }],
						responsibilities: [],
					};
					const accepted = await tools.find(tool => tool.name === "submit_requirements")!.execute("submit-1", payload);
					assert.equal(accepted.terminate, true);
					assert.deepEqual(result.consumeSubmission(), payload);
				}
			} finally { result.session.dispose(); }
		}
	} finally { f.cleanup(); }
});
