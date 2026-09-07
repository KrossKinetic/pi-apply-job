import assert from "node:assert/strict";
import test from "node:test";
import { checkStructure, inspectGeometry, parseBoundingBoxes, type PdfLine } from "../extensions/layout-qa.js";
import { planFixture } from "./fixtures.js";
const line = (text: string, y: number, x = 40, right = 550, height = 10): PdfLine => ({ text, y, x, right, bottom: y + height });
function splitBullet(text: string, y: number): PdfLine[] {
	const words = text.split(" ");
	const mid = Math.max(1, Math.ceil(words.length / 2));
	return [line(words.slice(0, mid).join(" "), y), line(words.slice(mid).join(" ") || words.at(-1)!, y + 12)];
}
function pageLines(plan = planFixture(), opts: { titleWrap?: boolean; extraSkills?: number; threeLineFirst?: boolean; bottom?: number; omitWorkHeading?: boolean; projectOneLine?: boolean; fourthJobLineCounts?: number[] } = {}): PdfLine[] {
	const lines: PdfLine[] = opts.titleWrap
		? [line("Example", 40, 130, 480, 16), line("Candidate", 58, 130, 480, 16)]
		: [line("Example Candidate", 40, 130, 480, 16)];
	lines.push(
		line("Example University", 80),
		line("Relevant Coursework: Data Structures, Foundations of Computer Science, Programming Abstractions", 110),
		line("Theory of Computation, Systems Fundamentals, Software Development, Object-Oriented Programming", 124),
		line("Technical Skills", 150),
		line("Languages: TypeScript, Python, Java", 164),
		line("Tools: Git, Docker, Linux", 178),
		line("Platforms: AWS, REST APIs, PostgreSQL", 192),
	);
	for (let i = 0; i < (opts.extraSkills ?? 0); i++) lines.push(line("More", 206 + i * 14));
	const workY = 220 + (opts.extraSkills ?? 0) * 14;
	if (!opts.omitWorkHeading) lines.push(line("Professional Work Experience", workY));
	let y = workY + 18;
	for (const [entryIndex, entry] of plan.workExperience.entries()) {
		for (const [bulletIndex, bullet] of entry.bullets.entries()) {
			if (opts.threeLineFirst && entryIndex === 0 && bulletIndex === 0) {
				const words = bullet.text.split(" ");
				lines.push(line(words.slice(0, 3).join(" "), y), line(words.slice(3, 6).join(" "), y + 14), line(words.slice(6).join(" "), y + 28));
				y += 42;
			} else if (entryIndex === 3 && opts.fourthJobLineCounts) {
				const count = opts.fourthJobLineCounts[bulletIndex] ?? 2;
				const words = bullet.text.split(" ");
				if (count <= 1) {
					lines.push(line(bullet.text, y));
					y += 14;
				} else {
					const mid = Math.max(1, Math.ceil(words.length / count));
					for (let part = 0; part < count; part++) {
						lines.push(line(words.slice(part * mid, part === count - 1 ? undefined : (part + 1) * mid).join(" ") || words.at(-1)!, y));
						y += 14;
					}
				}
			} else {
				lines.push(...splitBullet(bullet.text, y));
				y += 26;
			}
		}
	}
	lines.push(line("Projects", y));
	y += 16;
	for (const entry of plan.projects) {
		for (const bullet of entry.bullets) {
			if (opts.projectOneLine) {
				lines.push(line(bullet.text, y));
				y += 14;
			} else {
				lines.push(...splitBullet(bullet.text, y));
				y += 26;
			}
		}
	}
	lines.push(line("Bottom", opts.bottom ?? 700));
	return lines;
}

test("layout flags wrapping headers, missing hierarchy, and excess skill lines", () => {
	const wrapped = inspectGeometry([{ width: 612, height: 792, lines: pageLines(planFixture(), { titleWrap: true }) }], planFixture());
	assert.ok(wrapped.warnings.some(w => w.includes("title wraps")), JSON.stringify(wrapped.warnings));
	const skills = inspectGeometry([{ width: 612, height: 792, lines: pageLines(planFixture(), { extraSkills: 2 }) }], planFixture());
	assert.ok(skills.warnings.some(w => /Technical Skills occupies 5 lines/.test(w)), JSON.stringify(skills.warnings));
	const hierarchy = inspectGeometry([{ width: 612, height: 792, lines: pageLines(planFixture(), { omitWorkHeading: true }) }], planFixture());
	assert.ok(hierarchy.warnings.some(w => w.includes("hierarchy")), JSON.stringify(hierarchy.warnings));
});
test("entry and bullet limits are code constraints", () => {
	const plan = planFixture(); checkStructure(plan);
	plan.workExperience[0].bullets.splice(0, 2); assert.throws(() => checkStructure(plan), /workExperience\[0\] must have 3 bullets/);
	const project = planFixture(); project.projects[0].bullets.push(project.projects[0].bullets[0]!); assert.throws(() => checkStructure(project), /exactly 1 bullet/);
	const tooFew = planFixture(); tooFew.projects.pop(); assert.throws(() => checkStructure(tooFew), /exactly 5|3 work entries and 2 projects/);
	const tooFewWork = planFixture();
	tooFewWork.workExperience.splice(2, 1);
	tooFewWork.projects.push({ title: "Third Project", dates: "2021", evidence: ["project-03"], bullets: [{ text: "Built a typed API prototype with automated request validation.", evidence: ["project-04"] }] });
	assert.throws(() => checkStructure(tooFewWork), /3 work entries and 2 projects/);
	const missingEmployer = planFixture(); missingEmployer.workExperience[0].subtitle = ""; assert.throws(() => checkStructure(missingEmployer), /non-empty dates, employer subtitle, and location/);
	const fourth = planFixture();
	fourth.projects.pop();
	fourth.workExperience.push({
		title: "Intern", subtitle: "Example Company", dates: "2021 - 2022", location: "City, ST", evidence: ["role-01"],
		bullets: [
			{ text: "Shipped a compact intern project with measured latency gains on the shared API.", evidence: ["role-02"] },
			{ text: "Documented the rollback path.", evidence: ["role-04"] },
		],
	});
	checkStructure(fourth);
});

test("layout rejects a work-experience bullet that spans three PDF lines", () => {
	const plan = planFixture();
	const result = inspectGeometry([{ width: 612, height: 792, lines: pageLines(plan, { threeLineFirst: true }) }], plan);
	assert.ok(result.warnings.some(w => w.includes("bullet spanning 3 PDF lines")), JSON.stringify(result.warnings));
});
test("two-page PDFs still report work-bullet, skill, and overfull findings from page 1", () => {
	const plan = planFixture();
	const firstPage = pageLines(plan, { threeLineFirst: true, extraSkills: 2 }).filter(item => item.text !== "Bottom");
	const result = inspectGeometry(
		[{ width: 612, height: 792, lines: firstPage }, { width: 612, height: 792, lines: [line("Projects", 40)] }],
		plan,
		"Overfull \\hbox (12.0pt too wide) in paragraph at lines 12--13",
	);
	assert.ok(result.warnings.some(w => w.includes("Expected one page; found 2")));
	assert.ok(result.warnings.some(w => w.includes("bullet spanning 3 PDF lines")));
	assert.ok(result.warnings.some(w => /Technical Skills occupies 5 lines/.test(w)), JSON.stringify(result.warnings));
	assert.ok(result.warnings.some(w => w.includes("overflowing text")));
	assert.ok(!result.warnings.some(w => w.includes("Sparse page")), JSON.stringify(result.warnings));
	assert.equal(result.workBulletLineCounts.length, 8);
});
test("bullet mapping normalizes PDF ligatures", () => {
	const plan = planFixture();
	const target = "Improving reliability and efficiency";
	plan.workExperience[0]!.bullets[0]!.text = target;
	const lines = pageLines(plan);
	const idx = lines.findIndex(item => /improving reliability/i.test(item.text));
	assert.ok(idx >= 0);
	lines.splice(idx, 2, line("Improving reliability and eﬀiciency", lines[idx]!.y));
	const result = inspectGeometry([{ width: 612, height: 792, lines }], plan);
	assert.ok(!result.warnings.some(w => w.includes("Could not map")), JSON.stringify(result.warnings));
});
test("layout rejects a sparse page that leaves the lower half empty", () => {
	const result = inspectGeometry([{ width: 612, height: 792, lines: pageLines(planFixture(), { bottom: 580 }) }], planFixture());
	assert.ok(result.warnings.some(w => w.includes("Sparse page")), JSON.stringify(result.warnings));
	assert.ok(result.fillRatio < 0.85);
});
test("a filled page does not trip the sparse-page check", () => {
	const result = inspectGeometry([{ width: 612, height: 792, lines: pageLines(planFixture(), { bottom: 700 }) }], planFixture());
	assert.ok(!result.warnings.some(w => w.includes("Sparse page")), JSON.stringify(result.warnings));
	assert.ok(!result.warnings.some(w => w.includes("title wraps")), JSON.stringify(result.warnings));
	assert.ok(result.fillRatio >= 0.85);
});
function fourPlusOnePlan() {
	const plan = planFixture();
	plan.projects.pop();
	plan.workExperience.push({
		title: "Intern", subtitle: "Example Company", dates: "2021 - 2022", location: "City, ST", evidence: ["role-01"],
		bullets: [
			{ text: "Shipped a compact intern project with measured latency gains on the shared API used by campus teams.", evidence: ["role-02"] },
			{ text: "Documented the rollback path for failed intern deploys.", evidence: ["role-04"] },
		],
	});
	return plan;
}
test("layout requires the optional fourth job's two bullets to occupy 3 PDF lines total", () => {
	const plan = fourPlusOnePlan();
	const tooLong = inspectGeometry([{ width: 612, height: 792, lines: pageLines(plan, { fourthJobLineCounts: [2, 2], bottom: 720 }) }], plan);
	assert.ok(tooLong.warnings.some(w => /Fourth work entry bullets occupy 4 PDF lines/.test(w)), JSON.stringify(tooLong.warnings));
	const compact = inspectGeometry([{ width: 612, height: 792, lines: pageLines(plan, { fourthJobLineCounts: [2, 1], bottom: 720 }) }], plan);
	assert.ok(!compact.warnings.some(w => /Fourth work entry/.test(w)), JSON.stringify(compact.warnings));
});
test("layout rejects a one-line project bullet", () => {
	const result = inspectGeometry([{ width: 612, height: 792, lines: pageLines(planFixture(), { projectOneLine: true, bottom: 700 }) }], planFixture());
	assert.ok(result.warnings.some(w => /project bullet occupies 1 PDF lines/.test(w)), JSON.stringify(result.warnings));
});
test("layout requires coursework to occupy exactly two lines", () => {
	const plan = planFixture();
	const lines = pageLines(plan).filter(item => !/coursework|theory of computation/i.test(item.text));
	const result = inspectGeometry([{ width: 612, height: 792, lines }], plan);
	assert.ok(result.warnings.some(w => /Coursework occupies 0 lines/.test(w)), JSON.stringify(result.warnings));
});
test("Poppler XML is parsed and entities decoded", () => {
	const pages = parseBoundingBoxes('<page width="612" height="792"><flow><block><line xMin="40" yMin="40" xMax="80" yMax="50"><word xMin="40">A &amp; B</word></line></block></flow></page>');
	assert.equal(pages[0]!.lines[0]!.text, "A & B");
});
