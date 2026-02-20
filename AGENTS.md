# Grais Debugger Chrome Extension (Browser Relay)

## Purpose
This repository provides a local browser-relay so Grais can attach to a **chosen Chrome tab**, execute script in that tab, and return structured page data to an agent workflow.

- The extension manages tab attachment from the toolbar button.
- The relay server tunnels requests from the skill into Chrome DevTools Protocol (CDP).
- The `grais-tab-webdata-reader` skill reads and consumes the result payload from the relay and prints JSON directly to stdout.

## Capabilities
- Attach or detach the chosen tab from the extension toolbar.
- Recover/reconnect when tab context changes.
- Execute JavaScript in-page via CDP (`Runtime.evaluate`).
- Capture screenshots from the attached tab (`--screenshot`, optional `--screenshot-full-page`).
- Default extraction payload: `url`, `title`, `text`, `links`, `metaDescription`.
- Full DOM extraction with custom expression (e.g. `document.documentElement.outerHTML`).
- WhatsApp chat extraction using the `--preset whatsapp-messages` mode.
- Regex filtering:
  - Default extractor: `--text-regex`, `--exclude-text-regex`, `--link-text-regex`, `--link-href-regex`.
  - WhatsApp extractor: `--message-regex`, `--exclude-message-regex`, `--sender-regex`, `--exclude-sender-regex`.

## Setup
1. Install and open extension
   - Chrome → `chrome://extensions`
   - Enable Developer mode
   - Load unpacked and select `~/.codex/skills/private/grais-tab-webdata-reader/extension`
   - Pin Grais Debugger icon to the toolbar
2. Start relay server:

   ```bash
   cd ~/.codex/skills/private/grais-tab-webdata-reader
   npm install
   npm run relay:start
   ```

3. `relay:start` keeps relay running and auto-stops after 2 hours by default (to avoid start/stop churn).
   Override when needed:

   ```bash
   node scripts/relay-manager.js start --auto-stop-ms 10800000
   node scripts/relay-manager.js start --auto-stop-ms 0
   ```

4. Keep relay running continuously while using the extension and only stop when finished:

   ```bash
   npm run relay:status -- --status-timeout-ms 3000
   npm run relay:stop
   ```

5. Human attach gate (required for agent workflows):
   - After relay is started, the agent must pause and ask the human to attach the target tab:
     - Open/focus the target tab in Chrome.
     - Click the Grais Debugger toolbar icon so badge shows `ON`.
   - The agent must wait for human confirmation before continuing.
   - Before any read, the agent must run:

   ```bash
   node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
   ```

   Continue only when this check succeeds.

## Agent execution contract (mandatory)
- Use these exact scripts and command names. Do not search for alternatives and do not say they "may be named differently":
  - `npm run relay:start`
  - `npm run relay:status`
  - `npm run relay:stop`
  - `node scripts/read-active-tab.js`
- After `relay:start`, agent must stop and ask the human to attach the target tab, then wait for confirmation.
- Agent must run `node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000` before any data read and continue only on success.
- Agent must not stop/restart relay during a task unless the human explicitly asks for restart or a hard failure requires it.
- If canonical scripts are missing, fail fast with a concrete error and stop; do not pivot to a different pipeline.

Before running reads, also verify relay health:

```bash
curl --max-time 3 -sS http://127.0.0.1:18793/status
```

Expect `extensionConnected: true` and low queue depth before running fetches.
Never run bare `curl` without a timeout for relay checks.

## Workflow
1. Open and focus the target tab in Chrome.
2. Click the Grais Debugger icon to attach.
3. Validate readiness before each read:

   ```bash
   node scripts/read-active-tab.js --check
   ```
   ```bash
   node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
   ```

   If relay is reachable this command waits for an active attachment instead of immediate failure.

4. Read default extraction from attached tab:

   ```bash
   node scripts/read-active-tab.js --pretty false
   ```

5. Read full DOM:

   ```bash
   node scripts/read-active-tab.js \
     --expression "document.documentElement.outerHTML" --pretty false
   ```

6. Capture a screenshot:

   ```bash
   node scripts/read-active-tab.js \
     --screenshot \
     --screenshot-full-page \
     --screenshot-path "./tmp/page.png" \
     --pretty false
   ```

7. Read WhatsApp messages (dry-run target):

   ```bash
   node scripts/read-active-tab.js \
     --preset whatsapp-messages \
     --selector "#main [data-testid=\"conversation-panel-messages\"], #main" \
     --max-messages 200 \
     --pretty false
   ```

- `--wait-for-attach` waits for the bridge and tab attachment before running reads.
- `--attach-timeout-ms <ms>` controls the max wait time (default: `120000`).
- `--attach-poll-ms <ms>` controls retry frequency (default: `500`).

## Troubleshooting
- Red `!` badge: relay is unreachable or extension cannot attach.
- `Timed out waiting for Runtime.evaluate`: usually means the tab is not attached.
- If attachment drops after tab changes, click the toolbar icon once and run `--check` again.
- If you see unstable behavior, audit processes:

```bash
npm run relay:status -- --status-timeout-ms 3000
```
- Single running relay instance is enforced by an OS lock; stale lock files are cleaned automatically.

## Reliability notes
- Controller commands are queued while extension reconnects and replayed after the relay sees the extension again.
- When the extension is ON (`ON` badge), it runs a reconnect loop: it keeps trying to re-establish relay socket and restore tab attachment automatically.
- The relay now tracks extension heartbeats (`Grais.extensionHeartbeat`) and closes stale extension connections.
- Request windows remain bounded by timeouts, so callers receive deterministic errors for retries instead of waiting indefinitely.

## Skill source of truth
- The repository root here is the source of truth for both this project and the installable skill.
- Do not edit installed copies under global skill directories directly. Update this folder, commit & push, then refresh globals by reinstalling from GitHub.
