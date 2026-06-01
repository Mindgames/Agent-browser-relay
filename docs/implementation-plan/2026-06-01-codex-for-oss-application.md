# Codex for Open Source Application Alignment

Owner: Mathias Asberg
Date: 2026-06-01
Status: Implemented in `codex/oss-application-alignment`

## Motivation

OpenAI's Codex for Open Source form asks maintainers of active public OSS projects to prove repo visibility, maintainer role, ecosystem importance, and intended use for Codex Security and API credits. Agent Browser Relay is a public, actively maintained Chrome extension and local relay for agent workflows, but the repo needs OSS hygiene before the strongest possible submission.

Success means the application is truthful, concise, and backed by repo evidence rather than inflated adoption claims.

## Sources Checked

- OpenAI form page via Agent Browser Relay tab `671316587`: `https://openai.com/form/codex-for-oss/`.
- Relay health gates: `/status`, `npm run extension:status`, `npm run relay:status -- --all`, and `npm run relay:doctor -- --tab-id 671316587 --json`.
- Local repo files: `AGENTS.md`, `SKILL.md`, `README.md`, `CHANGELOG.md`, `package.json`, tracked file list.
- GitHub repo metadata: public repo, `v0.0.13`, latest push/release on 2026-04-02, 2 stars, 0 forks, 33 merged PRs, 0 open issues.
- NPM registry lookup: `agent-browser-relay` is not published.
- Local validation: `pnpm lint` and `pnpm build` pass; no test files were found.

## Scope

In scope:

- Fill the application fields with current true evidence.
- Add minimum OSS hygiene: explicit license, package metadata, CI, tests, security/contribution docs, and cleanup of tracked generated artifacts.
- Improve public discoverability and maintainership evidence.

Out of scope:

- Claiming npm downloads or large external adoption without proof.
- Submitting the form before required personal/account fields are confirmed.
- Restarting the relay or changing the attached Chrome profile as part of this application.

## Current Form Field Map

- `FirstName`: required, visible input.
- `LastName`: required, visible input.
- `Email`: required, visible email input tied to ChatGPT account.
- `mkto_github_profile`: required GitHub username.
- `mkto_github_repo_url`: required public GitHub repo URL.
- `LeadRole[]`: required radio, `Primary maintainer` or `Core maintainer`.
- `Qualifications`: required textarea, max 500 chars.
- `Interest`: optional checkboxes, `Codex Security` and `API credits`.
- `What_is_your_org_ID__c`: required OpenAI Organization ID, max 30 chars.
- `product_usage`: required textarea, max 500 chars.
- `isthereanythingelseyouwouldlikeustoknow`: optional textarea, max 500 chars.

## Alignment Gaps

- MIT `LICENSE` and package license metadata have been added.
- `package.json` no longer marks the project private, but the application should still rely on GitHub/install-via-skills evidence instead of npm downloads unless the package is later published.
- `.gitignore` now excludes generated dependencies, temp artifacts, and logs; tracked `node_modules/` and `tmp/*.png` have been removed from git.
- CI workflow has been added for `pnpm lint`, `pnpm build`, and `pnpm test`.
- A minimal contract test suite now covers package metadata, version sync, and canonical command documentation.
- `SECURITY.md` and `CONTRIBUTING.md` have been added; this matters because the project exposes local browser/CDP access and the program includes Codex Security.
- GitHub topics/description are sparse, and the README does not provide a concise "why this matters to OSS maintainers" summary.
- Package manager policy is mixed: `AGENTS.md` prefers pnpm, but `package-lock.json` is tracked and no `pnpm-lock.yaml` is present.

## Recommended Stages

### Stage 1 - Submit-Ready Truth Pack

Goal: Fill the form without overclaiming.

Expected output: Draft answer values under 500 characters and a clear list of missing user-owned fields.

- [x] Read the form and confirm required fields through tab `671316587`.
- [x] Verify relay health and tab lease before page reads.
- [x] Verify repo public URL and GitHub metadata.
- [x] Confirm current validation status with `pnpm lint` and `pnpm build`.
- [ ] Confirm ChatGPT account email.
- [ ] Confirm OpenAI Organization ID.
- [x] Confirm whether to select both `Codex Security` and `API credits`.

### Stage 2 - OSS Hygiene Before Final Submission

Goal: Make the repository look like a serious public OSS project.

Expected output: One cleanup PR with legal, package, and repo hygiene.

- [x] Choose a license with the owner, then add `LICENSE` and `package.json` `license`.
- [x] Decide whether the package remains GitHub-install-only or should become publishable; if publishable, remove `private: true` and add publish metadata.
- [x] Normalize package-manager state: add `packageManager`, generate `pnpm-lock.yaml`, remove `package-lock.json` if pnpm is canonical.
- [x] Update `.gitignore` for `node_modules/`, `tmp/`, logs, and local screenshots.
- [x] Remove tracked `node_modules/` and `tmp/*.png` artifacts from git.
- [x] Add GitHub topics such as `chrome-extension`, `browser-relay`, `ai-agents`, `devtools-protocol`, `codex`, and `browser-automation`.

### Stage 3 - Maintainer Quality Bar

Goal: Prove the repo has active maintenance and safety standards, not just working scripts.

Expected output: CI and minimal tests that cover the relay contract.

- [x] Add `.github/workflows/ci.yml` running `pnpm install`, `pnpm lint`, `pnpm build`, and `pnpm test`.
- [x] Add a minimal `node:test` suite for package metadata, version sync, and canonical command contracts.
- [x] Add `SECURITY.md` explaining local-only relay assumptions, CDP access boundaries, human attach gate, and disclosure process.
- [x] Add `CONTRIBUTING.md` with setup, validation, and release expectations.

### Stage 4 - Application Narrative Cleanup

Goal: Make the public repo and form answer tell the same story.

Expected output: README/metadata that substantiates the application in one pass.

- [x] Add a short README section describing why the relay matters for OSS maintainers: authenticated browser evidence, tab-scoped leases, deterministic preflight, and human-approved attach gates.
- [x] Keep the form answer focused on importance and maintenance burden instead of stars/downloads.
- [x] Mention the real evidence: public repo, active release series, 33 merged PRs, versioned changelog, and current relay safety features.
- [x] Avoid claiming npm downloads until the package is published and measurable.

## Draft Form Answers

GitHub username:

```text
Mindgames
```

GitHub repository URL:

```text
https://github.com/Mindgames/Agent-browser-relay
```

Role:

```text
Primary maintainer
```

Why this repository qualifies:

```text
Agent Browser Relay is public OSS for safer agentic AI browser work: a Chrome extension plus local relay that lets agents read only explicitly attached tabs with leases, CDP reads, screenshots, and deterministic preflight. It fills a critical gap for authenticated, human-approved browser evidence. Active since Mar 2026 with 33 merged PRs and v0.0.13 released.
```

API credit usage:

```text
Use API credits to build maintainer automation around the relay: Codex-driven PR review, issue triage, release checks, security audits, docs updates, and tests for relay lifecycle edge cases. The goal is safer agent workflows that depend on real browser evidence while preserving human attach gates and tab-scoped leases.
```

Anything else:

```text
Codex Security is especially relevant because this project gates local Chrome/CDP access for agents. We want deeper review of the attach, lease, relay, and expression-evaluation boundaries while keeping the tool useful for real maintainer workflows.
```

## Validation

- `pnpm lint` passes.
- `pnpm build` passes.
- `pnpm test` passes.
- Relay page read succeeded through tab `671316587`.
- Submit is intentionally blocked until email and OpenAI Organization ID are confirmed.
