import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getWorkspace } from "../extensions/utils.js";

test("resolves Pi's user-wide workspace", () => {
	const workspace = getWorkspace();
	const expectedRoot = path.join(path.dirname(getAgentDir()), "apply-job");

	assert.equal(workspace.rootDir, expectedRoot);
	assert.equal(workspace.jobsDir, path.join(expectedRoot, "jobs"));
	assert.equal(workspace.masterDir, path.join(expectedRoot, "master"));
	assert.equal(workspace.coverLetterDir, path.join(expectedRoot, "master", "cover-letter"));
});
