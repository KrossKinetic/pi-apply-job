import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureWorkspace, getWorkspace, workspaceAt, writeTextFile } from "../extensions/utils.js";

test("resolves Pi's user-wide workspace", () => {
	const workspace = getWorkspace();
	const expectedRoot = path.join(path.dirname(getAgentDir()), "apply-job");

	assert.equal(workspace.rootDir, expectedRoot);
	assert.equal(workspace.jobsDir, path.join(expectedRoot, "jobs"));
	assert.equal(workspace.masterDir, path.join(expectedRoot, "master"));
	assert.equal(workspace.coverLetterDir, path.join(expectedRoot, "master", "cover-letter"));
});

test("coordinator artifacts use private permissions and leave no temporary files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-job-permissions-"));
	try {
		const workspace = workspaceAt(path.join(root, "apply-job"));
		ensureWorkspace(workspace);
		const artifact = path.join(workspace.jobsDir, "artifact.json");
		writeTextFile(artifact, "{}\n");
		assert.equal(fs.statSync(workspace.rootDir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(workspace.jobsDir).filter(name => name.endsWith(".tmp")), []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
