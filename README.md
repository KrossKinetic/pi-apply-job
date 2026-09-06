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

Batch mode processes every job through drafting, factual review, quality review,
rendering, and layout QA without opening a per-job approval dialog. Each passing
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
selected entries, requirement coverage, excluded alternatives, and factual
findings. Pi offers **Open review page**, **Approve this version**, **Request a
revision**, **Lock a selected entry**, and **Review later**. A revision starts
a fresh bounded drafting/review cycle; locks preserve whole selected entries.
Approval is tied to the reviewed artifact version. Closing or cancelling the
dialog leaves the job awaiting approval. Non-interactive runs also stop there.
The PDF exists for review, but the job is not marked complete until approved.

All workers use the model and thinking level selected in Pi when the command
starts, including independent factual/quality reviewers and cover-letter workers.
That pair stays fixed throughout the command's batch and revision loops. There
is no automatic quality-variant switch or separate `reviewerModel` override.
Resuming captures Pi's current pair for new workers while reusing valid checkpoints.
The chosen provider, model, and thinking level are recorded in worker progress
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
content). Chat notifications are truncated to a bounded preview.
Drafting and cover-letter workers are capped at twelve model turns, sixteen
tool calls, 200,000 streamed characters, and twenty minutes per invocation.
Factual and quality reviewers receive a deterministic
one-file review packet; requirement extraction reads the posting once. Each must
submit its typed result after one evidence pass and is capped at five model turns,
six tool calls, 100,000 streamed characters, and eight minutes. A capped reviewer
is restarted once in a fresh context, then
the application fails explicitly rather than looping indefinitely. The selected
model/provider's own limits still apply. Existing factual-repair
and PDF-layout attempt limits remain in effect.

First a fresh worker extracts requirements with exact quotes from the posting.
The coordinator verifies that every quote actually occurs in the saved source.
The drafting worker analyzes, selects, rewrites, and self-checks the résumé
plan through `submit_resume_draft`. Its schema rejects wrong types, missing or
unknown fields, and arbitrary output paths before execution; semantic checks
then reject structural violations, unknown evidence IDs, inconsistent approval
flags, and a mismatched company or role. Validation failures return immediately
to the same worker so it can correct the submitted arguments. Only after a
submission passes does coordinator code write `analysis.md`, `resume-plan.json`,
the deterministically derived `resume.md`, `verification.json`, and metadata.
The requirement, factual-review, quality-review, cover-letter, and cover-letter-
review workers use equivalent role-specific submission gates. Before rendering,
a separate isolated verifier independently audits the
plan and preview against the master resume. A second isolated job-fit reviewer
then looks for only concrete, master-evidence-backed improvements for that
posting. A deterministic claim ledger maps plan fields to exact master-source
blocks and line numbers. Reviewers examine the source text as well as its IDs.
Master source-bullet boundaries do not constrain résumé bullets: a tailored
bullet may combine directly supported atomic facts from several source IDs, or
split a broad source block into distinct non-duplicative bullets. Every
contributing source ID is retained in that bullet's evidence array, and both
factual and quality reviewers audit the composite claim at clause level.
The quality review must cover every requirement exactly once as `supported`,
`unsupported_but_real`, or `irrelevant`, with explanations and links to selected
claims. Missing qualifications are recorded separately from fixable résumé
weaknesses; there is no quality-score threshold to chase. Review suggestions
must cite existing master facts, including stronger omitted alternatives.
Either reviewer sends actionable feedback to a fresh drafting context.
Malformed reviews get at most one retry; stale or contradictory approvals are
not accepted. Inputs modified during review invalidate the result.

There are at most four accepted content drafts (initial draft plus three
revisions) and three render attempts per revision window, persisted across
restarts. Failed or rejected tool submissions do not consume a content attempt.
Factual, quality, and structural changes share the content budget; measured
layout repairs use the render budget and do not create impossible rounds such
as 5/4.
Legacy malformed self-verification artifacts receive one schema-only migration
pass without consuming a content revision; new workers cannot create malformed
artifacts because their submission schema is enforced before coordinator writes.
If repeated quality preferences exhaust that budget, the last factually
verified candidate is rendered and sent to human review with the unresolved
quality suggestion visible; factual, structural, and layout failures still
block. An explicit human revision starts another bounded window.

The coordinator compiles the PDF, extracts line coordinates with Poppler, and
checks page count, header wrapping/centering, section order, skill line count,
tiny text, page-margin overflow, large gaps, and vertical fill. A layout failure
returns measured feedback to a fresh drafter and reruns both reviews. Skills
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
- analysis.md: evidence-based fit assessment
- resume-plan.json: selected content with master-resume evidence IDs
- verification.json: drafting worker's factual audit
- independent-verification.json: separate factual audit against the master resume
- job-requirement.json: AI-produced, quote-validated concise job brief for drafting and review
- claim-ledger.json: selected claims, source text, line numbers, and content hashes
- quality-review.json: complete requirement coverage and excluded alternatives
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
