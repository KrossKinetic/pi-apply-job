# Changelog

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
