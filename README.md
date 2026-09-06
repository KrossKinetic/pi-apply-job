# pi-apply-job

An evidence-backed job-application workflow for the [Pi coding agent](https://pi.dev).
It scrapes a public job posting, analyzes fit against a comprehensive private
resume, and generates a verified one-page LaTeX resume.

## Install

Install from npm after publication:

~~~
pi install npm:@krosskinetic/pi-apply-job
~~~

For local development:

~~~
pi install /absolute/path/to/pi-apply-job
~~~

## Required inputs

Run this once from any Pi workspace:

~~~
/apply-job-init
~~~

This creates the user-wide private workspace at `~/.pi/apply-job`. Before
applying to a job, add these private résumé sources. They are excluded from the
package and should not be committed to a public repository:

~~~
~/.pi/apply-job/master/resume.md
~/.pi/apply-job/master/template/resume-template.tex
~~~

For optional cover letters, add Markdown (`.md`) or plain-text (`.txt`) samples
to this third private source folder:

~~~
~/.pi/apply-job/master/cover-letter/
~~~

Use it for prior cover letters, personal writeups, and background notes that
show your voice, tone, motivations, and story. These are candidate-approved
sources for the cover-letter workflow; keep them factual and suitable for a
reviewer to use. Nested folders are supported. Binary documents are ignored, so
export Word or Google Docs material to Markdown or plain text first.

The Markdown master resume is the sole factual inventory. It may be many pages
long and should contain every truthful role, bullet, skill, course, project,
and award. Give facts stable IDs such as rel-03 so every tailored claim can be
audited.

The LaTeX template contains presentation only: packages, macros, typography,
and the PI:HEADER and PI:CONTENT markers. It must not contain candidate facts.

For batch processing, also create a plain-text job task list anywhere Pi can
read it. It contains the public job-posting URLs to process:

~~~
https://jobs.example.com/role/123,
https://boards.greenhouse.io/company/jobs/456
~~~

The list may be comma-separated, one URL per line, or semicolon-separated. It
is an input list only: the extension never submits applications or clicks Apply.

## Use

~~~
/apply-job https://jobs.example.com/role/123
~~~

To also create a tailored cover letter after the résumé is finished:

~~~
/apply-job --cover-letter https://jobs.example.com/role/123
~~~

For a job task list (comma-separated, one URL per line, or semicolon-separated):

~~~
/apply-job-file jobs.txt
~~~

Batch mode processes every job through drafting, deterministic PDF layout QA,
and factual review without opening a per-job approval dialog. Each passing
job is saved at `awaiting_approval`; when the batch finishes, review and approve
them individually with `/apply-job-review <job-folder>`.

Resume or review an existing application without scraping or creating another folder:

~~~
/apply-job-resume /absolute/path/to/existing/job-folder
/apply-job-review /absolute/path/to/existing/job-folder
/apply-job-revise /absolute/path/to/existing/job-folder :: Focus more on supported testing experience
~~~

Both commands reuse checkpoints only when their input and output hashes still
match. Changed source facts, plans, previews, reviews, or PDFs invalidate the
affected checks. Legacy plans are retained under `history/` and migrated by a
fresh drafter in the same job folder. A per-job coordinator lock prevents
concurrent resume operations. Interrupted processes can resume after exit.

Every tailored résumé uses exactly five combined work/research/project entries,
including at least three work/research entries. Work-experience bullets must
render within two PDF lines; code rejects an otherwise valid draft that exceeds
that limit.

After all checks pass, `review.html` puts the rendered PDF preview alongside
selected entries, the quote-validated job brief, and factual findings. Pi offers **Open review page**, **Approve this version**, **Request a
revision**, **Lock a selected entry**, and **Review later**. A revision starts
a fresh bounded drafting/review cycle; locks preserve whole selected entries.
Approval is tied to the reviewed artifact version. Closing or cancelling the
dialog leaves the job awaiting approval. Non-interactive runs also stop there.
The PDF exists for review, but the job is not marked complete until approved.
Completion requires a valid plan, a passing one-page layout report, a Low
factual approval bound to the current artifact hash, and human approval of that
same reviewed version.

The résumé pipeline uses the model selected in Pi when the command starts with
fixed role levels: **xhigh** for the drafter and targeted editor, and **low**
for the initial job-brief extractor and independent factual auditor. Cover-letter workers retain the
captured selection. Resuming captures Pi's current model for new workers while
reusing valid checkpoints. The chosen provider, model, and thinking level are recorded in worker progress
and `worker-model.json`.

## Worker architecture

The extension is the deterministic coordinator. For every application it creates
a fresh, in-memory Pi worker session per drafting or review invocation, using
the captured model and thinking pair. A worker receives only its assigned job prompt and reads that
job's files plus the private master materials; it has no history from another
application, no loaded skills or project context, and only a role-scoped reader
plus one typed submission tool. The reader accepts only coordinator-assigned
pipeline files; workers receive no generic read, write, edit, shell, or
caller-selected output-path capability.
The active provider's lifecycle extension is retained so providers such as MTPLX
can start their local model server.

While a worker runs, a live panel above the Pi editor shows the selected model,
elapsed time, current activity, model turns, tool calls, time since the last
event, and a streaming preview of its response. These measurements reset for
each isolated worker rather than accumulating across the application. Thinking is reported as activity;
completed response text and tool activity appear in Pi's chat area. These UI
updates do not add the worker conversation to the main agent's context.
Completed responses, tool activity, and phase changes are also saved to the
application's private, size-capped `worker-output.log` (which may contain resume
content). Completed-response chat notifications are truncated to a bounded
preview; tool-call failures are shown and logged in full.
Workers have no coordinator-imposed time, turn, tool-call, or streamed-character
limits. The selected model/provider's own limits still apply. Logical safeguards
remain: malformed factual reviews get one retry, factual-repair repetition stops
for human review, and PDF layout attempts remain bounded.

The initial Low worker extracts requirements with exact quotes from the posting.
The coordinator verifies every job quote against the saved source. The xhigh
drafter then analyzes, selects, rewrites, and self-checks the résumé
plan through `submit_resume_draft`. Its schema rejects wrong types, missing or
unknown fields, and arbitrary output paths before execution; semantic checks
then reject structural violations, unknown evidence IDs, and a mismatched
company or role. Validation failures return immediately
to the same worker so it can correct the submitted arguments. Only after a
submission passes does coordinator code write `resume-plan.json`,
the deterministically derived `resume.md` and metadata.
Before the Low factual audit, a deterministic claim ledger maps plan fields to
exact master-source blocks and line numbers. The reviewer examines the source text as well as its IDs.
Master source-bullet boundaries do not constrain résumé bullets: a tailored
bullet may combine directly supported atomic facts from several source IDs, or
split a broad source block into distinct non-duplicative bullets. Every
contributing source ID is retained in that bullet's evidence array, and the Low
reviewer audits every composite claim at clause level. It has no quality, ATS,
requirement-coverage, omitted-content, or keyword-optimization responsibility.
Each finding names the exact canonical plan path, offending clause, reason, and
source IDs examined. All findings are returned in one Low audit.

The xhigh editor receives those findings, an explicit allowlist, and the current
plan/master resume. It submits patches only: target path, replacement value, and
evidence IDs. Work/project fixes are limited to the exact bullet text/evidence
pair; skill fixes to one label/value field; coursework fixes to one course item.
Entry titles, employers, dates, locations, honors, and other
sections cannot be widened into a repair scope. Unauthorized patches are rejected
without changing the canonical plan. A repaired résumé gets a full Low re-audit.
If the same factual issue returns, or a finding has no permitted target, the
pipeline stops for human review rather than spending another xhigh call.

The coordinator compiles the PDF, extracts line coordinates with Poppler, and
checks page count, header wrapping/centering, section order, skill line count,
tiny text, page-margin overflow, large gaps, and vertical fill. A layout failure
after a targeted edit returns measured feedback to that same editor with its
existing allowlist; scope is never widened. Skills
are never scaled down to force a fit. Geometry checks do not replace human
visual judgment; the approval page includes the rendered preview.
With `--cover-letter`, this happens first; then a separate isolated
writer uses the candidate's cover-letter library to draft a 250–425 word
one-page letter. A second isolated reviewer checks its factual grounding,
job-specific relevance, tone, narrative quality, and length. The coordinator
passes any review feedback back to the writer for up to three draft/review
attempts. Batch jobs are fully completed one at a time before the next worker
is created.

Each application receives its own folder under `~/.pi/apply-job/jobs` containing:

- source.json and job.md: source job information
- resume-plan.json: selected content with master-resume evidence IDs
- independent-verification.json: separate factual audit against the master resume
- job-requirement.json: initial worker's quote-validated concise job brief
- claim-ledger.json: selected claims, source text, line numbers, and content hashes
- resume.tex and resume.pdf: deterministic renderer outputs
- layout.json, visual-qa.json, resume-preview.png: measured layout checks and preview
- pipeline-state.json: content-bound checkpoints, budgets, and locked selections
- review.html and human-approval.json: final review and version-specific approval
- history/: preserved artifacts from earlier drafts, including legacy plans
- metadata.json: overall stage, errors, and timestamps
- cover-letter.md and cover-letter-review.json: optional tailored letter and
  independent review record, created only with `--cover-letter`

The worker cannot solve overflow by changing the template. It revises only the
verified plan, while the coordinator calls the bundled renderer again. The
renderer requires exactly one PDF page and permits at most three render attempts.

## Requirements

Node.js 22.19 or newer is required by the supported Pi runtime.

The rendering step uses Tectonic and Poppler (`pdftotext`, `pdftoppm`). Install them before use:

~~~
brew install tectonic poppler
~~~

## Privacy and security

The published package includes no resumes, profiles, job history, generated
applications, or credentials. It accepts only public http(s) job URLs, rejects
non-global literal and DNS-resolved addresses, and applies the same check to
redirects and browser subresource requests. It never submits forms or clicks Apply.
Extensions run with the host user's permissions; install only trusted packages.

## Development and release

~~~
npm install
npm run check
npm run pack:check
~~~

Before publishing, run npm audit --omit=dev, test the packed artifact in a
disposable Pi project, and publish with npm publish --access public.

## License

[MIT](LICENSE)
