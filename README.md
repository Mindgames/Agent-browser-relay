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

### 1) Clone into the global `~/.agents` skills folder
Recommended (SSH):

```bash
mkdir -p ~/.agents/skills/private
git clone git@github.com:Mindgames/Agent-browser-relay.git ~/.agents/skills/private/agent-browser-relay
cd ~/.agents/skills/private/agent-browser-relay
npm install
```

If you prefer HTTPS:

```bash
mkdir -p ~/.agents/skills/private
git clone https://github.com/Mindgames/Agent-browser-relay.git ~/.agents/skills/private/agent-browser-relay
cd ~/.agents/skills/private/agent-browser-relay
npm install
```

### 2) Reuse the same skill for Claude CLI (single source of truth)
If you want one shared installation for both Codex CLI and Claude CLI, symlink Claude's global skill path:

```bash
mkdir -p ~/.claude/skills
ln -sfn ~/.agents/skills/private/agent-browser-relay ~/.claude/skills/agent-browser-relay
```

### 3) Load the extension in Chrome (Developer mode)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder:
   `~/.agents/skills/private/agent-browser-relay/extension`
5. Pin the **Grais Debugger** toolbar icon

If you move the repo, update this folder path in Chrome and re-load unpacked.

## Skill Directory Structure (`.agents` + `.claude`)

This repo integrates with two different skill roots:

- `~/.agents/skills/agent-browser/`
  - Houses the `agent-browser` skill/CLI workflow used for browser automation.
- `~/.agents/skills/private/agent-browser-relay`
  - Canonical global skill path for this relay project.
- `~/.claude/skills/agent-browser-relay`
  - Optional symlink to reuse the same repo in Claude CLI.
- `~/.agents/skills/private/agent-browser-relay/extension`
  - Exact Chrome extension directory to load in Developer mode.

Why this matters: one clone under `~/.agents` avoids drift, and Claude can consume the same files via symlink.

## Components

- `extension/background.js`: attach/detach and tab bridge lifecycle.
- `relay-server.js`: local relay + CDP tunnel.
- `scripts/relay-service.js`: global `launchd/systemd --user` service lifecycle.
- `scripts/read-active-tab.js`: read/check CLI that prints JSON.
- Relay tab leasing (`--tab-id`): isolates concurrent agents to specific tabs.

## Relay Endpoint Defaults

```bash
export GRAIS_RELAY_HOST=127.0.0.1
export GRAIS_RELAY_PORT=18793
export GRAIS_ATTACH_TIMEOUT_MS=120000
```

Set these before commands if your relay endpoint differs.

## Start Relay (Preferred: Global Service)

```bash
npm run relay:global:install -- --ports "${GRAIS_RELAY_PORT:-18793}" --timeout 12000
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
npm run relay:start -- --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --status-timeout-ms 3000
```

## Required Attach Gate (Before Any Read)

After relay startup, a human must attach the target tab:
1. Open/focus target tab in Chrome.
2. Open Grais Debugger popup.
3. Click **Attach this tab**.
4. Confirm badge shows `ON`.

Then run:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --check --wait-for-attach --attach-timeout-ms "${GRAIS_ATTACH_TIMEOUT_MS:-120000}"
```

For multi-agent runs, always target a specific tab lease:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --check --wait-for-attach --attach-timeout-ms "${GRAIS_ATTACH_TIMEOUT_MS:-120000}"
```

## Health Check (Timeout Required)

Never run bare `curl` for relay checks. Use timeout:

```bash
curl --max-time 3 -sS "http://${GRAIS_RELAY_HOST:-127.0.0.1}:${GRAIS_RELAY_PORT:-18793}/status"
```

Continue only when status reports:
- `extensionConnected: true`
- low queue depth

## Read Data

Default extraction (`url`, `title`, `text`, `links`, `metaDescription`):

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --pretty false
```

Specific tab lease:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --pretty false
```

Full DOM:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --expression "document.documentElement.outerHTML" --pretty false
```

Screenshot:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --screenshot --screenshot-full-page --screenshot-path "./tmp/page.png" --pretty false
```

WhatsApp messages:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --preset whatsapp-messages --selector "#main [data-testid=\"conversation-panel-messages\"], #main" --max-messages 200 --pretty false
```

## Multi-Port Behavior

- Tabs without a saved mapping use `GRAIS_RELAY_PORT` (default `18793`).
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

- Attachment lost after navigation/reload:
  - Re-open popup on that tab.
  - Click **Attach this tab** again.
  - Re-run the `--check --wait-for-attach` command.

- Sparse checkout accidentally hid folders in canonical skill copy:

```bash
cd ~/.agents/skills/private/agent-browser-relay
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
