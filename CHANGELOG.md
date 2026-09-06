# Changelog

## Unreleased

- Moves the measured PDF layout check ahead of the independent facts/quality
  reviews, and runs it eagerly inside `submit_resume_draft`'s own `execute()`,
  right when the drafter submits. A layout defect (e.g. an overflowing skills
  line) now fails the tool call immediately, in the same worker turn, so the
  drafter fixes and resubmits before either expensive independent LLM review
  ever runs on content that would just be discarded. The coordinator's own
  layout gate (`review-engine.ts`) is reordered the same way as a fallback,
  and the three-render budget now resets per genuinely new content draft
  instead of being shared with ordinary content-revision churn, so quality
  or facts churn can no longer be misreported as "render attempts exhausted".
  Locked-entry enforcement moved into the same tool call (before persistence)
  so a rejected locked-entry change is never written to disk.
- Fixes the `submit_resume_draft` schema/semantics mismatch that repeatedly
  caused runtime rejections: `resumePlan.sections` (free-text titles, a
  `kind` discriminator, and optional work-entry fields) is replaced with
  explicit `workExperience`/`projects` arrays. The fixed "Work Experience"
  and "Projects" headings are now owned entirely by the renderer, work
  entries require non-empty `dates`/`subtitle`/`location` in the visible
  schema (not just in semantic validation), and project entries are
  structurally limited to exactly one bullet. Duplicate, misnamed, or
  misordered section titles are now impossible instead of prose-enforced.
- Fixes a double-serialized `resumePlan` argument (e.g. `resumePlan: "{...}"`)
  being rejected before our tool code ever runs. The agent runtime validates
  tool-call arguments against the exposed TypeBox schema itself
  (`@earendil-works/pi-ai`'s pre-execute `validateToolArguments`), so a strict
  object-only schema made the runtime throw `must be object` without ever
  reaching `submit_resume_draft`'s `execute()`. The exposed schema for each
  top-level object/array field now also accepts a raw JSON string so that
  layer passes the argument through; `validateWorkerSubmission` then parses
  and re-validates it against the real, strict schema, so no leniency is
  introduced into the actual contract.
- Allows quality-review `alternatives[].evidence` to be empty so a worker can
  correctly exclude a requirement for lack of any master-resume support
  (an absence has no source ID to cite) without failing schema validation.
- Fixes isolated workers disabling their own custom tools through an empty SDK
  allowlist; enables exactly the reader and role submission tool and verifies the
  active tools before inference. Adds real SDK session regression coverage.
- Replaces worker filesystem mutation tools with closed, role-specific typed
  submission tools and coordinator-owned artifact persistence.
- Removes the obsolete manual render tool that could bypass independent review;
  rendering now runs only inside the checkpointed coordinator.
- Adds independent factual and job-quality review loops, bounded worker budgets,
  revision-round awareness, stable evidence tradeoffs, and human review fallback.
- Enforces five-entry structure, complete work-entry headings, two-line work
  bullets, deterministic education/skills rendering, and PDF geometry checks.
- Hardens job retrieval against non-public literal, DNS-resolved, redirect, and
  browser subresource URLs.
- Restricts worker reads to role-specific allowlists and bounds worker wall time,
  streamed output, transcripts, and UI notifications.
- Expands release checks to compile tests, reject unused code, and run the full
  regression suite before publishing.

## 0.3.0 - 2026-08-30

- Replaces the redundant master profile with a two-source architecture:
  comprehensive master/resume.md plus a content-free LaTeX template.
- Adds the apply_job_render_resume Pi tool. It validates evidence-linked
  plans, generates TeX, compiles with Tectonic, and enforces one-page output
  without mutating the template.

## 0.2.0 - 2026-08-30

- Adds /apply-job-file for comma-, newline-, or semicolon-separated public
  job-posting URLs.
- Prepares postings independently and tailors successful applications
  sequentially.

## 0.1.0 - 2026-08-30

- Initial public package release.
