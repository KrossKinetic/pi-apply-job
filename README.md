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

In the project where applications are managed, run:

~~~
/apply-job-init
~~~

Before applying to a job, add exactly two private source files. They are
excluded from the package and should not be committed to a public repository:

~~~
.pi/apply-job/master/resume.md
.pi/apply-job/master/template/resume-template.tex
~~~

The Markdown master resume is the sole factual inventory. It may be many pages
long and should contain every truthful role, bullet, skill, course, project,
and award. Give facts stable IDs such as rel-03 so every tailored claim can be
audited.

The LaTeX template contains presentation only: packages, macros, typography,
and the PI:HEADER and PI:CONTENT markers. It must not contain candidate facts.

For batch processing, also create a plain-text job task list anywhere in the
project. It contains the public job-posting URLs to process:

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

For a job task list (comma-separated, one URL per line, or semicolon-separated):

~~~
/apply-job-file jobs.txt
~~~

## Worker architecture

The extension is the deterministic coordinator. For every application it creates
a fresh, in-memory Pi worker session using the currently selected model and
thinking level. A worker receives only its assigned job prompt and reads that
job's files plus the private master materials; it has no history from another
application, no loaded extensions or skills, and only read/write/edit tools.

The worker analyzes, selects, rewrites, and fact-checks the résumé plan. The
coordinator then validates cited master-resume IDs, compiles the PDF, and sends
only compact page-count feedback to that same worker if it needs a shorter
plan. Batch jobs are fully completed one at a time before the next worker is
created.

Each application receives its own folder under .pi/apply-job/jobs containing:

- source.json, job.md, and job.json: source job information
- analysis.md: evidence-based fit assessment
- resume-plan.json: selected content with master-resume evidence IDs
- verification.json: factual audit result
- resume.tex and resume.pdf: deterministic renderer outputs
- layout.json and metadata.json: render state, page count, and timestamps

The worker cannot solve overflow by changing the template. It revises only the
verified plan, while the coordinator calls the bundled renderer again. The
renderer requires exactly one PDF page and permits at most three render attempts.

## Requirements

The rendering step uses Tectonic and pdfinfo. Install them before use:

~~~
brew install tectonic poppler
~~~

## Roadmap

- [ ] Add a separate, isolated cover-letter worker. It will select from a private
  master cover-letter paragraph library and writing-style samples to produce a
  tailored cover letter for each job alongside the tailored résumé.

## Privacy and security

The published package includes no resumes, profiles, job history, generated
applications, or credentials. It accepts only public http(s) job URLs, blocks
obvious localhost/private-IP targets, and never submits forms or clicks Apply.
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
