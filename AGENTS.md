# Grais Debugger Chrome Extension (Browser Relay)

## Purpose
This repository provides a local browser-relay so Grais can attach to a **chosen Chrome tab**, execute script in that tab, and return structured page data to an agent workflow.

- The extension manages tab attachment from the toolbar popup.
- The relay server tunnels requests from the skill into Chrome DevTools Protocol (CDP).
- The `grais-tab-webdata-reader` skill reads and consumes the result payload from the relay and prints JSON directly to stdout.

## Capabilities
- Attach or detach the chosen tab from the toolbar popup.
- Keep multiple tabs attached concurrently in one extension instance.
- Recover/reconnect when tab context changes.
- Execute JavaScript in-page via CDP (`Runtime.evaluate`).
- Capture screenshots from the attached tab (`--screenshot`, optional `--screenshot-full-page`).
- Relay session/lease isolation for multi-agent workflows (`--tab-id`).
- Default extraction payload: `url`, `title`, `text`, `links`, `metaDescription`.
- Full DOM extraction with custom expression (e.g. `document.documentElement.outerHTML`).
- WhatsApp chat extraction using the `--preset whatsapp-messages` mode.
- Regex filtering:
  - Default extractor: `--text-regex`, `--exclude-text-regex`, `--link-text-regex`, `--link-href-regex`.
  - WhatsApp extractor: `--message-regex`, `--exclude-message-regex`, `--sender-regex`, `--exclude-sender-regex`.

## Setup
### Relay endpoint
Default host/port is `127.0.0.1:18793`. If your relay is on a different port, set these env vars before any command:

```bash
export GRAIS_RELAY_HOST=127.0.0.1
export GRAIS_RELAY_PORT=18793
```

1. Install and open extension
   - After checking out the repository, run `npm run codex:install` to map this copy into:
     `~/.codex/skills/private/grais-tab-webdata-reader`
   - Chrome → `chrome://extensions`
   - Enable Developer mode
   - Load unpacked and select `~/.codex/skills/private/grais-tab-webdata-reader/extension`
   - Pin Grais Debugger icon to the toolbar
   - Run `npm install` once if this checkout has never installed dependencies.
2. Start relay server:

   ```bash
   npm run relay:start
   ```

   If your relay is on another host/port:

   ```bash
   export GRAIS_RELAY_HOST=127.0.0.1
   export GRAIS_RELAY_PORT=18793
   npm run relay:start -- --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}"
   ```

3. `relay:start` keeps relay running and auto-stops after 2 hours by default (to avoid start/stop churn).
   Override when needed:

   ```bash
  node scripts/relay-manager.js start --auto-stop-ms 10800000
  node scripts/relay-manager.js start --auto-stop-ms 0
  ```

If the `.codex` working tree ever loses subfolders after fetch/reset operations (for example `extension/`), run:

```bash
cd ~/.codex/skills/private/grais-tab-webdata-reader
git sparse-checkout disable
git config --unset-all core.sparseCheckout || true
git config --unset-all core.sparseCheckoutCone || true
git checkout -- .
```

This refreshes sparse state and restores all missing tracked directories in the skill copy.

4. Keep relay running continuously while using the extension and only stop when finished:

   ```bash
   npm run relay:status -- --status-timeout-ms 3000
   npm run relay:stop
   ```

5. Human attach gate (required for agent workflows):
   - After relay is started, the agent must pause and ask the human to attach the target tab:
     - Open/focus the target tab in Chrome.
     - Open the toolbar popup and click **Attach this tab** so the badge shows `ON`.
   - The agent must wait for human confirmation before continuing.
   - Before any read, the agent must run:

   ```bash
   node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --check --wait-for-attach --attach-timeout-ms 120000
   ```

   Continue only when this check succeeds.

### Per-tab relay port behavior
- If you start relay on multiple ports, one extension install can manage different ports by tab.
- If a tab has no saved relay-port mapping, it uses the global default (`GRAIS_RELAY_PORT`, default `18793`).
- On successful attach, the extension stores that tab’s relay port mapping.
- Returning to that tab reuses the mapped port automatically.
- Closing a tab clears its tab->port mapping.

## Agent execution contract (mandatory)
- Use these exact scripts and command names. Do not search for alternatives and do not say they "may be named differently":
  - `npm run relay:start`
  - `npm run relay:status`
  - `npm run relay:stop`
  - `node scripts/read-active-tab.js`
- After `relay:start`, agent must stop and ask the human to attach the target tab, then wait for confirmation.
- Agent must run `node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --check --wait-for-attach --attach-timeout-ms 120000` before any data read and continue only on success.
- For multi-agent or concurrent runs, agent must use tab leasing by setting `--tab-id <tabId>` on all read/check commands.
- Agent must resolve `tabId` from relay status (`/status` or `npm run relay:status -- --all`) and explicitly target that tab.
- Agent must not stop/restart relay during a task unless the human explicitly asks for restart or a hard failure requires it.
- Agent must not restart relay only because local code changed. Code updates are picked up only on explicit human-approved restart.
- If the page shows human-verification gates (for example "Are you human?" or CAPTCHA), agent must stop immediately, alert the human with [$attention-please](/Users/mathiasasberg/.codex/skills/public/attention-please/SKILL.md), and wait for explicit human confirmation before continuing.
- If canonical scripts are missing, fail fast with a concrete error and stop; do not pivot to a different pipeline.

Before running reads, also verify relay health:

```bash
curl --max-time 3 -sS "http://${GRAIS_RELAY_HOST:-127.0.0.1}:${GRAIS_RELAY_PORT:-18793}/status"
```

Expect `extensionConnected: true` and low queue depth before running fetches.
Never run bare `curl` without a timeout for relay checks.

## Workflow
1. Open and focus the target tab(s) in Chrome.
2. Open the Grais Debugger popup and click "Attach this tab" for each tab an agent should use.
3. Resolve each target `tabId` from status output (`npm run relay:status -- --all --status-timeout-ms 3000`).
4. Validate readiness before each read:

   ```bash
   node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --check
   ```
   ```bash
   node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --check --wait-for-attach --attach-timeout-ms 120000
   ```

   If relay is reachable this command waits for an active attachment instead of immediate failure.

5. Read default extraction from a specific leased tab:

   ```bash
   node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --tab-id "<TAB_ID>" --pretty false
   ```

6. Read full DOM:

   ```bash
   node scripts/read-active-tab.js \
     --expression "document.documentElement.outerHTML" --pretty false
   ```

   ```bash
   node scripts/read-active-tab.js \
     --host "${GRAIS_RELAY_HOST:-127.0.0.1}" \
     --port "${GRAIS_RELAY_PORT:-18793}" \
     --tab-id "<TAB_ID>" \
     --expression "document.documentElement.outerHTML" --pretty false
   ```

7. Capture a screenshot:

   ```bash
   node scripts/read-active-tab.js \
     --screenshot \
     --screenshot-full-page \
     --screenshot-path "./tmp/page.png" \
     --pretty false
   ```

   ```bash
   node scripts/read-active-tab.js \
     --host "${GRAIS_RELAY_HOST:-127.0.0.1}" \
     --port "${GRAIS_RELAY_PORT:-18793}" \
     --tab-id "<TAB_ID>" \
     --screenshot \
     --screenshot-full-page \
     --screenshot-path "./tmp/page.png" \
     --pretty false
   ```

8. Read WhatsApp messages (dry-run target):

   ```bash
   node scripts/read-active-tab.js \
     --preset whatsapp-messages \
     --selector "#main [data-testid=\"conversation-panel-messages\"], #main" \
     --max-messages 200 \
     --pretty false
   ```

   ```bash
   node scripts/read-active-tab.js \
     --host "${GRAIS_RELAY_HOST:-127.0.0.1}" \
     --port "${GRAIS_RELAY_PORT:-18793}" \
     --tab-id "<TAB_ID>" \
     --preset whatsapp-messages \
     --selector "#main [data-testid=\"conversation-panel-messages\"], #main" \
     --max-messages 200 \
     --pretty false
   ```

- `--wait-for-attach` waits for the bridge and tab attachment before running reads.
- `--attach-timeout-ms <ms>` controls the max wait time (default: `120000`).
- `--attach-poll-ms <ms>` controls retry frequency (default: `500`).
- `--tab-id <id>` enables relay session lease routing so each agent is isolated to a specific tab.

When check/read succeeds, payload includes:
`source.relayHost`, `source.relayPort`, `source.relayStatusUrl`, and `source.relayWebSocketUrl` so humans can confirm the active relay endpoint.

## Troubleshooting
- Red `!` badge: relay is unreachable or extension cannot attach.
- `Timed out waiting for Runtime.evaluate`: usually means the tab is not attached.
- If attachment drops after tab changes, open the toolbar popup on the target tab and click **Attach this tab** again, then run `--check` again.
- If you see unstable behavior, audit processes:

```bash
npm run relay:status -- --status-timeout-ms 3000
```
- To inspect mapped port activity across all listeners:

```bash
npm run relay:status -- --all --status-timeout-ms 3000
```
- Single running relay instance is enforced by an OS lock; stale lock files are cleaned automatically.

## Reliability notes
- Controller commands are queued while extension reconnects and replayed after the relay sees the extension again.
- When the extension is ON (`ON` badge), it runs a reconnect loop: it keeps trying to re-establish relay socket and restore tab attachment automatically.
- The relay now tracks extension heartbeats (`Grais.extensionHeartbeat`) and closes stale extension connections.
- Request windows remain bounded by timeouts, so callers receive deterministic errors for retries instead of waiting indefinitely.
- Relay updates policy: do not restart the running relay just because repository files changed. Continue with the running process; restart only when explicitly requested by the human or when a hard failure cannot be recovered by re-attach + check.

## Skill source of truth
- The repository root here is the source of truth for both this project and the installable skill.
- Do not edit installed copies under global skill directories directly. Update this folder, commit & push, then refresh globals by reinstalling from GitHub.
