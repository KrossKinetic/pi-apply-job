/**
 * Python Tools Loader
 *
 * Scans a directory for .py files and executes them via Python
 * to extract tool definitions (name, description, parameters, run).
 */

import { execFile } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { promisify } from "util";
import path from "path";

const execFileP = promisify(execFile);

export interface PythonTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	filePath: string;
	run: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Discover all .py files in the tools directory.
 */
export const loadPythonTools = (toolsDir: string): PythonTool[] => {
	const tools: PythonTool[] = [];

	try {
		const files = readdirSync(toolsDir).filter(
			(f) => f.endsWith(".py") && !f.startsWith("_"),
		);

		for (const file of files) {
			const filePath = path.join(toolsDir, file);
			const tool = parsePythonTool(filePath);
			if (tool) {
				tools.push(tool);
			}
		}
	} catch {
		// Directory doesn't exist or can't be read — no tools loaded
	}

	return tools;
};

/**
 * Parse a Python file to extract the tool definition.
 */
const parsePythonTool = (filePath: string): PythonTool | null => {
	const content = readFileSync(filePath, "utf-8");

	const name = extractString(content, "name");
	const description = extractString(content, "description");

	if (!name || !description) {
		return null;
	}

	const parameters = extractDict(content, "parameters") || {};

	return {
		name,
		description,
		parameters,
		filePath,
		run: createPythonRunner(filePath),
	};
};

/**
 * Extract a string value: name = "hello" or description = ( "multi" "line" )
 */
const extractString = (content: string, key: string): string | null => {
	// Try single-line first: name = "hello"
	const singlePattern = new RegExp(`${key}\\s*=\\s*["'](.+?)["']`);
	const singleMatch = content.match(singlePattern);
	if (singleMatch) return singleMatch[1];

	// Try multi-line parenthesized: description = ( "line1" "line2" )
	const multiPattern = new RegExp(`${key}\\s*=\\s*\\(([^)]+)\\)`, "s");
	const multiMatch = content.match(multiPattern);
	if (multiMatch) {
		// Strip quotes and whitespace, concatenate segments
		return (
			multiMatch[1]
				.match(/"([^"]*)"/g)
				?.map((s) => s.slice(1, -1))
				.join(" ")
				.trim() || null
		);
	}

	return null;
};

/**
 * Extract a dict value: parameters = {"key": {"type": "string"}}
 */
const extractDict = (
	content: string,
	key: string,
): Record<string, unknown> | null => {
	const assignment = new RegExp(`${key}\\s*=\\s*\\{`).exec(content);
	if (!assignment || assignment.index === undefined) return null;

	const start = content.indexOf("{", assignment.index);
	let depth = 0;
	let quote: string | null = null;
	let escaped = false;
	let end = -1;
	for (let index = start; index < content.length; index += 1) {
		const character = content[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
		} else if (character === "{") {
			depth += 1;
		} else if (character === "}" && --depth === 0) {
			end = index + 1;
			break;
		}
	}
	if (end === -1) return null;

	try {
		return JSON.parse(content.slice(start, end));
	} catch {
		return null;
	}
};

/**
 * Create a runner function that invokes the Python script's run() function.
 */
const createPythonRunner =
	(filePath: string): ((params: Record<string, unknown>) => Promise<unknown>) =>
	async (params: Record<string, unknown>) => {
		const moduleDirectory = JSON.stringify(path.dirname(filePath));
		const moduleName = JSON.stringify(path.basename(filePath, ".py"));
		const wrapperScript = `
import asyncio, json, sys
sys.path.insert(0, ${moduleDirectory})
mod = __import__(${moduleName})
result = asyncio.run(mod.run(json.loads(sys.argv[1])))
print(json.dumps({"result": result} if result is not None else {"result": ""}))
`;

		let stdout: string;
		try {
			({ stdout } = await execFileP("python3", [
				"-c",
				wrapperScript,
				JSON.stringify(params),
			], { maxBuffer: 2 * 1024 * 1024, timeout: 45_000 }));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Python tool ${path.basename(filePath)} failed: ${message}`);
		}

		try {
			const parsed = JSON.parse(stdout.trim());
			return parsed.result;
		} catch {
			return stdout.trim();
		}
	};
