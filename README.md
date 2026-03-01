# Grais Debugger Chrome Extension (Browser Relay)

Use this project to let Grais read data from the **attached Chrome tab** through a local relay.

## What runs where
- Extension (`extension/background.js`): attaches/detaches a chosen tab.
- Relay (`relay-server.js`): local bridge default host/port `127.0.0.1:18793`, configurable per run.
- Global relay service (`scripts/relay-service.js`): user-level launchd/systemd service for always-on relay lifecycle.
- Reader (`scripts/read-active-tab.js`): executes reads and prints JSON.
- Relay sessions: controllers can lease a specific tab id so concurrent agents on one relay stay isolated.

Set once per shell session if you run on a different endpoint:

```bash
export GRAIS_RELAY_HOST=127.0.0.1
export GRAIS_RELAY_PORT=18793
export GRAIS_ATTACH_TIMEOUT_MS=120000
```

## 1) Clone and wire skill path
From your preferred checkout location:

```bash
git clone git@github.com:Replypilot/grais-debug-relay.git
cd grais-debug-relay
npm run codex:install
```

If you use HTTPS:

```bash
git clone https://github.com/Replypilot/grais-debug-relay.git
cd grais-debug-relay
npm run codex:install
```

If pulls/fetches into this folder ever make `extension/` disappear, the repo has entered sparse mode.

```bash
cd ~/.codex/skills/private/browser-relay
git sparse-checkout disable
git config --unset-all core.sparseCheckout || true
git config --unset-all core.sparseCheckoutCone || true
git checkout -- .
```

This should instantly restore `extension`, `scripts`, and all other tracked folders in the local `.codex` copy.

## 2) One-time Chrome setup
1. Load extension in Chrome:
   - Open `chrome://extensions`
   - Enable Developer mode
   - Run `npm run codex:install` once after checkout (or after moving the repo)
   - Load unpacked from `~/.codex/skills/private/browser-relay/extension`
   - Pin Grais Debugger icon

### Per-tab relay port behavior
You can run one relay process with multiple ports (`--ports`) and attach different tabs to different ports from the same extension install:
- If a tab has not been attached before, it uses the global default port (`GRAIS_RELAY_PORT`, default `18793`).
- After a successful attach, the extension stores that tab’s relay port and reuses it on future attaches.
- This lets one extension instance survive with mixed ports per tab.
- Tab-to-port mappings are cleared automatically when a tab is closed.

## 3) Start a session (always this order)
### Recommended: install as a global service (for multiple agents)
For shared work across agents, keep one relay service running and never stop it manually until explicitly needed.
This "global" mode is user-level on your machine (`launchd` on macOS / `systemd --user` on Linux), not a root system daemon.

```bash
cd grais-debug-relay
npm run relay:global:install -- --ports 18793 --timeout 12000
```

Useful lifecycle commands:

```bash
npm run relay:global:status
npm run relay:global:stop
npm run relay:global:start
npm run relay:global:restart
npm run relay:global:update
npm run relay:global:uninstall
```

When relay code changes, update by restarting/reinstalling so the new binary is picked up by the managed service (only when explicitly requested/planned):

```bash
git pull
npm run relay:global:update -- --wait-for-ready --ready-timeout-ms 10000
```

If you prefer one-off startup instead of service management, use the existing `relay:start` flow in the steps below.
### Legacy one-off start

1. Start relay:

```bash
cd grais-debug-relay
npm run relay:start -- --status-timeout-ms 3000
```

Use explicit host/port if you are not on defaults:

```bash
cd grais-debug-relay
npm run relay:start -- --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --status-timeout-ms 3000
```

To start multiple listeners in one relay process:

```bash
npm run relay:start -- --ports 18793,18794 --status-timeout-ms 3000
```

2. Confirm relay is up:

```bash
npm run relay:status -- --status-timeout-ms 3000
```

To inspect all active ports/tabs:

```bash
npm run relay:status -- --all --status-timeout-ms 3000
```

Expected for multi-port:
- `ports`: when multiple listeners are configured, includes each configured port with `extensionConnected`, `activeTab`, and `attachedTabs`.
- `ok: true`
- `extensionConnected: true` after you complete the attach step below

Sample fields:
- `attachedTabs`: array of attached browser tabs (`tabId`, `title`, `url`, `targetId`)
- `extensionConnected`: relay-side extension websocket state per port

3. Human attach step (required for agent runs):
   - Open/focus target tab in Chrome
   - Click Grais Debugger icon to open the popup
   - Optional: set a **Tab port** override for that tab if you use multiple relays
   - Click **Attach this tab**
   - Confirm badge shows `ON`
   - Tell agent when done

4. Verify attach before any read:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --check --wait-for-attach --attach-timeout-ms "${GRAIS_ATTACH_TIMEOUT_MS:-120000}"
```

For multi-agent runs (recommended), verify the assigned tab lease explicitly:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --check --wait-for-attach --attach-timeout-ms "${GRAIS_ATTACH_TIMEOUT_MS:-120000}"
```

Continue only when this command succeeds.

Note:
- Reads target the currently attached tab unless you pass `--tab-id`.
- With `--tab-id`, the reader opens a relay session and claims a tab lease so commands/events stay scoped to that tab.
- If attach state drifts (for example after reconnect/reload), open the icon popup on the intended tab and click **Attach this tab**, then run the check command again.
- Relay restart policy for agents: do not restart the running relay for routine tasks or just because local files changed; restart only on explicit human instruction or unrecoverable hard failure.

## 4) Read data
Default structured payload (`url`, `title`, `text`, `links`, `metaDescription`):

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --pretty false
```

Target a specific tab id (recommended for concurrent agents):

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id 123 --pretty false
```

Full DOM:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --expression "document.documentElement.outerHTML" --pretty false
```

Screenshot (full page):

```bash
node scripts/read-active-tab.js \
  --host "${GRAIS_RELAY_HOST:-127.0.0.1}" \
  --port "${GRAIS_RELAY_PORT:-18793}" \
  --screenshot \
  --screenshot-full-page \
  --screenshot-path "./tmp/page.png" \
  --pretty false
```

WhatsApp messages:

```bash
node scripts/read-active-tab.js \
  --host "${GRAIS_RELAY_HOST:-127.0.0.1}" \
  --port "${GRAIS_RELAY_PORT:-18793}" \
  --preset whatsapp-messages \
  --selector "#main [data-testid=\"conversation-panel-messages\"], #main" \
  --max-messages 200 \
  --pretty false
```

## 5) Relay lifecycle
Global service mode:

```bash
npm run relay:global:status
npm run relay:global:stop
npm run relay:global:start
npm run relay:global:restart
```

Legacy one-off mode:

Status:

```bash
npm run relay:status -- --status-timeout-ms 3000
```

Stop:

```bash
npm run relay:stop
```

Notes:
- `relay:global:install` sets `--max-runtime-ms 0` (no auto-stop) for always-on relay behavior.
- `relay:start` auto-stops after 2 hours by default.
- Override: `node scripts/relay-manager.js start --auto-stop-ms 10800000`
- Disable auto-stop: `node scripts/relay-manager.js start --auto-stop-ms 0`
- Multi-port status check:

```bash
npm run relay:status -- --all --status-timeout-ms 3000
```

## 6) Troubleshooting
- Relay unreachable:

```bash
npm run relay:status -- --status-timeout-ms 3000
```

- Extension bridge disconnected (`extensionConnected: false`):
  - Re-focus target tab
  - Click extension icon again
  - Re-run `npm run relay:status -- --status-timeout-ms 3000`
  - Re-run check command

- See all active port status and attached tabs:

```bash
npm run relay:status -- --all --status-timeout-ms 3000
```

- Add or remove relay listeners without restarting:

```bash
node scripts/relay-manager.js ports --action add --ports 18795
node scripts/relay-manager.js ports --action remove --ports 18794
```

- `Timed out waiting for Runtime.evaluate`:
  - Tab is usually not attached
  - Re-attach and re-run:

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --check --wait-for-attach --attach-timeout-ms "${GRAIS_ATTACH_TIMEOUT_MS:-120000}"
```

- Clean restart:

```bash
npm run relay:stop
npm run relay:start -- --status-timeout-ms 3000
```

or in global service mode:

```bash
npm run relay:global:restart -- --wait-for-ready --ready-timeout-ms 10000
```

Note: every successful read/check response contains:
`source.relayHost`, `source.relayPort`, `source.relayStatusUrl`, and `source.relayWebSocketUrl` so humans can identify which relay endpoint is active.
