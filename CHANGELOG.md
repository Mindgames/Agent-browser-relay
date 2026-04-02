# Changelog

All notable changes to Agent Browser Relay are tracked here.

## [Unreleased]

- No unreleased entries yet.

## [0.0.13] - 2026-04-02

### Added

- Added a top-level `CHANGELOG.md` so shipped release history lives in the repo instead of only in GitHub releases.

### Changed

- Refreshed the extension icon set with a simpler dark monogram mark that matches the popup and options page styling more closely.
- Improved the Agent Browser Relay skill trigger metadata and `agents/openai.yaml` invocation guidance so the skill is easier to discover and invoke correctly.

## [0.0.12] - 2026-04-02

### Added

- Browser host identity and persistent profile id in relay heartbeat/status payloads.
- Browser identity surfacing in `extension:status`, `relay:status`, and `read-active-tab.js` source metadata.

### Changed

- Clarified documentation so multi-port per-tab routing is not misrepresented as first-class multi-browser orchestration.

## [0.0.11] - 2026-03-21

### Added

- Harder relay preflight readiness checks through `relay:doctor`.
- Safer `--expression-file` and `--expression-stdin` input paths for `read-active-tab.js`.
- Better lease conflict diagnostics and concurrent tab workflow guidance.

## [0.0.10] - 2026-03-08

### Fixed

- Persistence for the first target-created tab attachment flow.
