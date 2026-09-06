import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("scraper rejects non-public literal addresses before opening a connection", () => {
	const scraper = path.resolve("extensions/tools/url_retrieve.py");
	const script = [
		"import importlib.util, json, sys",
		"sys.dont_write_bytecode = True",
		"spec = importlib.util.spec_from_file_location('url_retrieve', sys.argv[1])",
		"mod = importlib.util.module_from_spec(spec)",
		"spec.loader.exec_module(mod)",
		"urls = sys.argv[2:]",
		"print(json.dumps([mod._is_safe_public_url(url) for url in urls]))",
	].join("; ");
	const urls = ["http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254", "http://[::1]", "https://8.8.8.8"];
	const output = execFileSync("python3", ["-c", script, scraper, ...urls], { encoding: "utf8" });
	assert.deepEqual(JSON.parse(output), [false, false, false, false, true]);
});
