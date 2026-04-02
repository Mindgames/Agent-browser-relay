# Agent Browser Relay (Chrome)

Agent Browser Relay lets your agent control and read from tabs in your real Chrome session, including multiple attached tabs in parallel, without forcing a separate browser profile.

## Why Use It

- Run agent reads on multiple attached tabs concurrently with per-tab lease scoping (`--tab-id`) inside one shared extension instance.
- Execute on background/non-focused tabs while you continue using your browser.
- Keep your real logged-in session (cookies, auth state, extensions) instead of re-automating login in a disposable browser.
- Extract structured page data, full DOM, screenshots, and chat/message presets via one CLI.
- Pass complex custom expressions safely via `--expression-file` or `--expression-stdin` instead of fragile shell quoting.
- Recover from tab/context changes with reconnect + attach checks designed for long-running agent workflows.
- Stop safely when CAPTCHA/human verification appears, and alert the user before continuing.

## What You Get

- Chrome extension bridge for attach/detach from the toolbar popup.
- Local relay service with global always-on mode (`launchd` / `systemd --user`).
- Scriptable read/check interface (`node scripts/read-active-tab.js`) for agent workflows.
- One-command readiness preflight via `npm run relay:doctor`.
- Explicit tab leasing model for multi-agent safety on shared relay infrastructure.

## Concurrency Model

- Multiple tabs can be attached at the same time.
- A given attached tab can only be actively leased by one relay session at a time.
- `--tab-id` scopes an agent run to one attached tab lease. It does not create a private browser or extension instance.
- Use `npm run relay:status -- --all --status-timeout-ms 3000` to inspect:
  - `attachedTabs[].leasedSessionId`
  - `tabLeases`
  - `leaseSummary.availableAttachedTabIds`
- If a tab is already leased, the supported recovery path is to wait for that session to finish, or choose another attached tab without an active lease. Do not force takeover.

## Quick Start (Human Setup)

### 1) Choose your install mode

#### Global install with `skills` (recommended)

```bash
npx skills add Mindgames/Agent-browser-relay -g -y
```

Try this folder in Chrome first:
`~/agent-browser-relay/extension`

If that folder is missing, use:
`~/.agents/skills/agent-browser-relay/extension`

#### Project or local checkout

If you are working from this repository directly, load this folder in Chrome:
`<your-checkout>/extension`

Examples:
- `/Users/you/Projects/Agent-browser-relay/extension`
- `/Users/you/code/agent-browser-relay/extension`

To print the exact paths for the copy you are using, run `npm run extension:path` from that copy.
It now prints the primary extension folder plus stable absolute paths for `read-active-tab.js` and `preflight.sh`.

Notes:
- `skills add` guarantees the installed skill at `~/.agents/skills/agent-browser-relay`
- `~/agent-browser-relay/extension` is only a convenience path when it exists
- if `~/agent-browser-relay/extension` is missing, run `npm run extension:install` or load the hidden skill path directly

### 2) Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. In the Chrome file picker, press `Command+Shift+G`
5. Paste the exact extension folder path:
   - `~/agent-browser-relay/extension` for a global install, if that folder exists
   - otherwise `~/.agents/skills/agent-browser-relay/extension` for a global install
   - `<your-checkout>/extension` for a project or local checkout
6. Press Enter, then select the `extension` folder if Chrome does not open it automatically
7. Pin the **Agent Browser Relay** toolbar icon

This `Command+Shift+G` step is the easiest option on macOS because it works even when `.agents` is hidden.

If you prefer to browse manually in Finder:
- press `Command+Shift+.` to show hidden files
- then browse to `agent-browser-relay/extension`
- if that folder is missing, browse to `.agents/skills/agent-browser-relay/extension`

`relay:start`, `relay:global:install`, and `read-active-tab.js` also print the primary load path + version sync status as stderr hints.

### 3) Backup download option

If hidden folders are still getting in the way, use a ZIP fallback instead:

1. Download the repo ZIP: [Mindgames/Agent-browser-relay main.zip](https://github.com/Mindgames/Agent-browser-relay/archive/refs/heads/main.zip)
2. Unzip it anywhere convenient
3. In Chrome, click **Load unpacked**
4. Select the `extension` folder inside the unzipped repo

This is a fallback only. The primary install path is still the one from your global install or local checkout.

### 4) Confirm the extension is loaded in Chrome

1. Start the relay
2. Open the Chrome tab you want the agent to use
3. Open the **Agent Browser Relay** popup from the toolbar icon
4. Wait for the popup status to show `Relay connected on <port>`
5. Or confirm from the terminal:

```bash
npm run extension:status -- --port "18793" --wait-for-connected --connected-timeout-ms 120000
```

### 5) Attach tabs and allow broader tab control

1. With the popup open on the target tab, click **Attach this tab** and confirm the badge shows `ON`.
2. If you want the agent to create its own background tabs, enable **Allow agent to create new background tabs** in the popup.
3. In **Connections**, click **Copy ID** for the attached tab and send it to your agent, for example: `Use tab 4581930`.
4. Repeat for every tab you want the agent to access.

### 6) Showcase: User + Agent Flow

Example prompt to your agent:

`Use Agent Browser Relay to audit the current page and summarize the most important links. Use tab 4581930.`

Expected flow:

1. Agent starts relay (for example `npm run relay:global:install -- --ports 18793 --timeout 12000`).
2. On a new machine, agent tells you which extension folder to load first:
   - `~/agent-browser-relay/extension` for a global install, if that folder exists
   - otherwise `~/.agents/skills/agent-browser-relay/extension` for a global install
   - `<your-checkout>/extension` for a project or local checkout
   - or asks you to run `npm run extension:path`
3. Agent asks you to open the popup once so Chrome proves the extension is loaded, then checks `npm run extension:status -- --port "18793" --wait-for-connected --connected-timeout-ms 120000`.
4. If the workflow needs a specific existing tab, agent asks you to click **Attach this tab** in the popup.
5. If the workflow only needs a new agent-created tab, the agent can create it itself once **Allow agent to create new background tabs** is enabled.
6. Agent runs `npm run relay:doctor -- --port "18793" --tab-id 4581930 --json` for existing-tab workflows, or `npm run relay:doctor -- --port "18793" --require-target-create --json` for first-tab creation workflows, and continues only when it returns success.

## Relay Skill Paths

`agent-browser-relay` is its own skill. It does not live inside or depend on the separate `agent-browser` skill.

The paths that matter for this project are:

- `~/.agents/skills/agent-browser-relay`
  - Canonical global install path for the `agent-browser-relay` skill.
- `~/.claude/skills/agent-browser-relay`
  - Optional Claude-side skill path, usually created by the installer when Claude Code is present.
- `~/agent-browser-relay/extension`
  - Optional visible convenience copy created by `npm run extension:install` when writable.

Why this matters: the relay extension should be loaded from an `agent-browser-relay` path, not from `agent-browser`.

## Components

- `extension/background.js`: attach/detach and tab bridge lifecycle.
- `relay-server.js`: local relay + CDP tunnel.
- `scripts/relay-service.js`: global `launchd/systemd --user` service lifecycle.
- `scripts/read-active-tab.js`: read/check CLI that prints JSON.
- `scripts/relay-manager.js`: relay lifecycle plus the canonical `doctor` preflight wrapper.
- `scripts/extension-status.js`: confirms whether Chrome has actually loaded the extension into the running profile.
- Relay tab leasing (`--tab-id`): isolates concurrent agents to specific tabs.
- `scripts/extension-install-helper.js`: prints the primary extension path and optionally refreshes the visible convenience copy.

## Capability library exposed to callers

`read-active-tab.js` includes a machine-readable capability block in each JSON payload (`source.capabilities`), including:
- CLI switches (`--check`, `--check --require-target-create`, `--metadata`, `--screenshot`, `--expression`, `--expression-file`, `--expression-stdin`, presets, `--tab-id`, etc.)
- Relay methods used by the client (`Grais.relay.*`)
- Bridge methods (`Grais.debugger.*`)
- Common CDP methods exposed for extraction and screenshots
- Installed/observed extension version metadata (`source.extension`) so tooling can warn on mismatches and redirect humans to updates.

## Relay Endpoint Defaults

Defaults are set directly in code:
- Host: `127.0.0.1`
- Port: `18793`
- Attach timeout: `120000` ms

Override per command with flags such as `--host`, `--port`, and `--attach-timeout-ms` when needed.

## Start Relay (Preferred: Global Service)

```bash
npm run relay:global:install -- --ports 18793 --timeout 12000
npm run relay:global:status
```

Other lifecycle commands:

```bash
npm run relay:global:start
npm run relay:global:stop
npm run relay:global:restart
npm run relay:global:update
npm run relay:global:uninstall
```

### Legacy one-off mode (fallback)

```bash
npm run relay:start
npm run relay:status -- --status-timeout-ms 3000
```

Or explicit host/port:

```bash
npm run relay:start -- --host 127.0.0.1 --port 18793 --status-timeout-ms 3000
```

`relay:start` now keeps the relay running until you stop it or the underlying process is restarted. If you want a bounded one-off session, pass `--auto-stop-ms` explicitly:

```bash
node scripts/relay-manager.js start --auto-stop-ms 10800000
```

## Required Attach Gate (Before Any Read)

After relay startup, a human must confirm the extension is loaded before any read or tab-create workflow:
1. Open/focus target tab in Chrome.
2. Open Agent Browser Relay popup once and confirm the popup shows `Relay connected on <port>`.
3. Confirm from the terminal with `npm run extension:status -- --port "18793" --wait-for-connected --connected-timeout-ms 120000`.
4. If you want the agent to work on an existing tab, click **Attach this tab**.
5. If you want the agent to create its own first tab, enable **Allow agent to create new background tabs** in the popup.

Then run the canonical preflight for an existing attached tab:

```bash
npm run relay:doctor -- --port "18793" --tab-id "<TAB_ID>" --json
```

If your workflow will create the first agent-controlled tab via `Target.createTarget`, require that readiness explicitly:

```bash
npm run relay:doctor -- --port "18793" --require-target-create --json
```

`node scripts/read-active-tab.js --check ...` remains available as the lower-level equivalent for local/manual debugging, but `relay:doctor` is the canonical agent preflight.

For multi-agent runs, always target a specific tab lease:

```bash
npm run relay:doctor -- --port "18793" --tab-id "<TAB_ID>" --json
```

If `relay:doctor` reports `TAB_LEASED_BY_OTHER_SESSION`, inspect relay status and choose another attached tab without an active lease:

```bash
npm run relay:status -- --all --status-timeout-ms 3000
```

If your workflow will open background tabs via `Target.createTarget`, require that readiness explicitly:

```bash
npm run relay:doctor -- --port "18793" --require-target-create --json
```

## Health Check (Timeout Required)

Never run bare `curl` for relay checks. Use timeout:

```bash
curl --max-time 3 -sS "http://127.0.0.1:18793/status"
```

Continue only when status reports:
- `extensionConnected: true`
- low queue depth
- for tab-spawn workflows: `allowTargetCreate: true` (or run `--check --require-target-create`)

## Read Data

Default extraction (`url`, `title`, `text`, `links`, `metaDescription`):

```bash
node scripts/read-active-tab.js --pretty false
```

Specific tab lease:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --pretty false
```

Full DOM:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --expression "document.documentElement.outerHTML" --pretty false
```

Prefer `--expression-file` or `--expression-stdin` for multi-line or quote-heavy expressions.

Complex custom expression from file:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --expression-file "./tmp/expression.js" --pretty false
```

Complex custom expression from stdin:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --expression-stdin --pretty false < ./tmp/expression.js
```

Screenshot:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --screenshot --screenshot-full-page --screenshot-path "./tmp/page.png" --pretty false
```

WhatsApp messages:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --preset whatsapp-messages --selector "#main [data-testid=\"conversation-panel-messages\"], #main" --max-messages 200 --pretty false
```

## Concurrent Tab Workflows

- Use `npm run relay:status -- --all --status-timeout-ms 3000` before choosing a tab for a concurrent run.
- Treat `attachedTabs` as the candidate pool and `tabLeases` / `leasedSessionId` as the current lease view.
- Prefer `leaseSummary.availableAttachedTabIds` when choosing the next `--tab-id`.
- Pass `--tab-id` on every check/read command so the relay can keep controller routing scoped to that tab.
- If doctor reports `TAB_LEASED_BY_OTHER_SESSION`, wait for that session to release the tab or choose another attached tab id from status.
- Lease isolation only controls relay command routing for attached tabs. It does not create a separate Chrome profile, cookie jar, or full browser-process isolation.

## Multi-Port Behavior

- Tabs without a saved mapping use the relay default port (`18793`).
- After successful attach, tab-to-port mapping is stored and reused.
- Closing a tab clears its mapping.

Inspect all ports/tabs:

```bash
npm run relay:status -- --all --status-timeout-ms 3000
```

## Troubleshooting

- Relay unreachable:

```bash
npm run relay:status -- --status-timeout-ms 3000
```

- Relay start timed out:
  - Read the startup error and relay log printed by `npm run relay:start`.
  - Do not assume sandbox/network restrictions unless the output shows an actual permission error.

- Unsure which extension folder to load:
  - Run `npm run extension:path` from the installed skill directory.
  - Load the primary path it prints in `chrome://extensions`.

- Unsure whether Chrome actually loaded the extension:
  - Open the Agent Browser Relay popup once.
  - Run `npm run extension:status -- --port "18793" --wait-for-connected --connected-timeout-ms 120000`.
  - Continue only when it reports `Chrome extension connected`.

- Agent says it cannot create a new tab yet:
  - Enable **Allow agent to create new background tabs** in the popup.
  - Re-run `npm run relay:doctor -- --port "18793" --require-target-create --json`.
  - If you want the agent to use an existing tab instead, attach that tab and pass its `tabId`.

- Unsure whether relay + extension + attached tab are all actually ready:
  - Run `npm run relay:doctor -- --port "18793" --tab-id "<TAB_ID>" --json`.
  - Inspect `blocker.code`, `blocker.summary`, and `blocker.nextAction`.

- Doctor says the requested tab is leased by another session:
  - Run `npm run relay:status -- --all --status-timeout-ms 3000`.
  - Inspect `attachedTabs`, `tabLeases`, and the blocker `detail` field to see which session owns which tab.
  - Retry with another attached `tabId`, or wait for the owning session to release the tab.

- Agent says a tab is already leased by another session:
  - Run `npm run relay:status -- --all --status-timeout-ms 3000`.
  - Inspect `attachedTabs[].leasedSessionId`, `tabLeases`, and `leaseSummary.availableAttachedTabIds`.
  - Wait for the owning session to finish, or retry with another attached tab id that has no active lease.

- Visible convenience folder missing after install:
  - Run `npm run extension:install` from the installed skill directory.
  - Confirm `~/agent-browser-relay/extension` now exists if you want that shortcut.

- Attachment lost after navigation/reload:
  - Re-open popup on that tab.
  - Click **Attach this tab** again.
  - Re-run the `--check --wait-for-attach` command.

- Sparse checkout accidentally hid folders in canonical skill copy:

```bash
cd ~/.agents/skills/agent-browser-relay
git sparse-checkout disable
git config --unset-all core.sparseCheckout || true
git config --unset-all core.sparseCheckoutCone || true
git checkout -- .
```

## Agent Contract (Canonical Commands)

Use only these script names:

- `npm run relay:global:install`
- `npm run relay:global:status`
- `npm run relay:global:start`
- `npm run relay:global:stop`
- `npm run relay:start`
- `npm run relay:status`
- `npm run relay:doctor`
- `npm run relay:stop`
- `npm run extension:path`
- `npm run extension:status`
- `node scripts/read-active-tab.js`

Do not restart relay just because local files changed. Restart only when explicitly requested by a human, or for hard recovery failures.

If CAPTCHA/human verification appears, stop immediately, alert the user, and wait for explicit confirmation before continuing.

## Recommended Companion

For human-in-the-loop workflows, we recommend using [attention-please](https://github.com/Mindgames/attention-please) so the user gets an immediate alert when manual action is needed (for example CAPTCHA or verification gates).

Made by Mathias Asberg: [GitHub](https://github.com/Mindgames), [X](https://x.com/mathiiias123), [LinkedIn](https://www.linkedin.com/in/imathias/).
