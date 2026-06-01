# Contributing

Agent Browser Relay is a small Chrome extension plus local relay. Keep changes narrow, explicit, and easy to verify.

## Setup

```bash
pnpm install
```

Load the extension path printed by:

```bash
pnpm extension:path
```

## Validation

Run the repo-native checks before opening a pull request:

```bash
pnpm lint
pnpm build
pnpm test
```

For relay behavior changes, also run the gateway readiness flow against an explicitly attached tab:

```bash
pnpm extension:status -- --wait-for-connected --connected-timeout-ms 120000
pnpm relay:status -- --all --status-timeout-ms 3000
pnpm relay:doctor -- --host "127.0.0.1" --port "18793" --tab-id "<TAB_ID>" --json
```

## Pull Requests

- Keep generated files and local screenshots out of git.
- Update `README.md`, `SKILL.md`, or `AGENTS.md` when behavior, commands, or safety contracts change.
- Add or update tests when changing command parsing, version metadata, relay preflight, or status contracts.
- Do not restart a user's running relay just because local code changed.
