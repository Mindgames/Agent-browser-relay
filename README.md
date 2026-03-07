# Agent Browser Relay (Chrome)

Agent Browser Relay lets your agent control and read from tabs in your real Chrome session, including multiple attached tabs in parallel, without forcing a separate browser profile.

## Why Use It

- Run agent reads on multiple attached tabs concurrently with per-tab lease isolation (`--tab-id`).
- Execute on background/non-focused tabs while you continue using your browser.
- Keep your real logged-in session (cookies, auth state, extensions) instead of re-automating login in a disposable browser.
- Extract structured page data, full DOM, screenshots, and chat/message presets via one CLI.
- Recover from tab/context changes with reconnect + attach checks designed for long-running agent workflows.
- Stop safely when CAPTCHA/human verification appears, and alert the user before continuing.

## What You Get

- Chrome extension bridge for attach/detach from the toolbar popup.
- Local relay service with global always-on mode (`launchd` / `systemd --user`).
- Scriptable read/check interface (`node scripts/read-active-tab.js`) for agent workflows.
- Explicit tab leasing model for multi-agent safety on shared relay infrastructure.

## Quick Start (Human Setup)

### 1) Install with `skills` CLI (recommended)

```bash
npx skills add Mindgames/Agent-browser-relay
```

For unattended global install (recommended in automations/scripts):

```bash
npx skills add Mindgames/Agent-browser-relay -g -y
```

On a fresh machine, the first `npm run relay:start` or `npm run relay:global:install` also syncs a visible Chrome extension folder to `~/agent-browser-relay/extension` and prints that path. Load that folder in Chrome before debugging attach/read failures.

### 2) Load the extension in Chrome (Developer mode)
After install with the `skills` installer, the skill is available at:
`~/.agents/skills/agent-browser-relay`

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder:
   `~/agent-browser-relay/extension`

`relay:start`, `relay:global:install`, and `read-active-tab.js` keep this folder synced and print the install path + version sync status as stderr hints, so humans do not need to find hidden folders.
5. Pin the **Agent Browser Relay** toolbar icon

### 3) Attach tabs and allow broader tab control

1. Open the Chrome tab you want the agent to use.
2. Open the **Agent Browser Relay** popup from the toolbar icon.
3. Click **Attach this tab** and confirm the badge shows `ON`.
4. If you want the agent to open additional background tabs, enable **Allow agent to open new background tabs** in the popup.
5. In **Connections**, click **Copy ID** for the attached tab and send it to your agent, for example: `Use tab 4581930`.
6. Repeat for every tab you want the agent to access.

### 4) Showcase: User + Agent Flow

Example prompt to your agent:

`Use Agent Browser Relay to audit the current page and summarize the most important links. Use tab 4581930.`

Expected flow:

1. Agent starts relay (for example `npm run relay:global:install -- --ports 18793 --timeout 12000`).
2. On a new machine, agent tells you to load `~/agent-browser-relay/extension` in `chrome://extensions` first.
3. Agent asks you to open/focus the target tab and click **Attach this tab** in the popup.
4. You attach the tab and confirm.
5. Agent runs the attach check and continues reads using the tab ID you shared.

## Skill Directory Structure (`.agents` + `.claude`)

This repo integrates with two different skill roots:

- `~/.agents/skills/agent-browser/`
  - Houses the `agent-browser` skill/CLI workflow used for browser automation.
- `~/.agents/skills/agent-browser-relay`
  - Canonical global skill path for this relay project.
- `~/.claude/skills/agent-browser-relay`
  - Usually symlinked automatically by the `skills` installer when Claude Code is present.
- `~/agent-browser-relay/extension`
  - Visible Chrome extension directory printed by the skill and safe for manual navigation in Chrome.

Why this matters: installer-based setup gives a stable path and keeps Codex/Claude integrations consistent.

## Components

- `extension/background.js`: attach/detach and tab bridge lifecycle.
- `relay-server.js`: local relay + CDP tunnel.
- `scripts/relay-service.js`: global `launchd/systemd --user` service lifecycle.
- `scripts/read-active-tab.js`: read/check CLI that prints JSON.
- Relay tab leasing (`--tab-id`): isolates concurrent agents to specific tabs.
- `scripts/extension-install-helper.js`: keeps a visible extension install folder in sync.

## Capability library exposed to callers

`read-active-tab.js` includes a machine-readable capability block in each JSON payload (`source.capabilities`), including:
- CLI switches (`--check`, `--check --require-target-create`, `--metadata`, `--screenshot`, `--expression`, presets, `--tab-id`, etc.)
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

## Required Attach Gate (Before Any Read)

After relay startup, a human must attach the target tab:
1. Open/focus target tab in Chrome.
2. Open Agent Browser Relay popup.
3. Click **Attach this tab**.
4. Confirm badge shows `ON`.

Then run:

```bash
node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
```

For multi-agent runs, always target a specific tab lease:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --check --wait-for-attach --attach-timeout-ms 120000
```

If your workflow will open background tabs via `Target.createTarget`, require that readiness explicitly:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --check --wait-for-attach --require-target-create --attach-timeout-ms 120000
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

Screenshot:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --screenshot --screenshot-full-page --screenshot-path "./tmp/page.png" --pretty false
```

WhatsApp messages:

```bash
node scripts/read-active-tab.js --tab-id "<TAB_ID>" --preset whatsapp-messages --selector "#main [data-testid=\"conversation-panel-messages\"], #main" --max-messages 200 --pretty false
```

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
- `npm run relay:stop`
- `node scripts/read-active-tab.js`

Do not restart relay just because local files changed. Restart only when explicitly requested by a human, or for hard recovery failures.

If CAPTCHA/human verification appears, stop immediately, alert the user, and wait for explicit confirmation before continuing.

## Recommended Companion

For human-in-the-loop workflows, we recommend using [attention-please](https://github.com/Mindgames/attention-please) so the user gets an immediate alert when manual action is needed (for example CAPTCHA or verification gates).

Made by Mathias Asberg: [GitHub](https://github.com/Mindgames), [X](https://x.com/mathiiias123), [LinkedIn](https://www.linkedin.com/in/imathias/).
