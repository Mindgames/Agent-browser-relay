# Grais Debugger Chrome Extension (Browser Relay)

## Purpose
This repository provides a local browser-relay so Grais can attach to the **active Chrome tab**, execute script in that tab, and return structured page data to an agent workflow.

- The extension manages active-tab attachment from the toolbar button.
- The relay server tunnels requests from the skill into Chrome DevTools Protocol (CDP).
- The `grais-tab-webdata-reader` skill reads and consumes the result payload from the relay and prints JSON directly to stdout.

## Capabilities
- Attach or detach the active tab from the extension toolbar.
- Recover/reconnect when the active tab changes.
- Execute JavaScript in-page via CDP (`Runtime.evaluate`).
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
   - Load unpacked and select this folder
   - Pin Grais Debugger icon to the toolbar
2. Start relay server:

   ```bash
   cd /Users/mathiasasberg/Projects/grais/api+chrome/chrome-debugger
   npm install
   npm run relay:start
   ```

3. Keep relay running continuously while using the extension and only stop when finished:

   ```bash
   npm run relay:status
   npm run relay:stop
   ```

Before running reads, also verify relay health:

```bash
curl -s http://127.0.0.1:18792/status
```

Expect `extensionConnected: true` and low queue depth before running fetches.

## Workflow
1. Open the target page and make it active in Chrome.
2. Click the Grais Debugger icon to attach.
3. Validate readiness before each read:

   ```bash
   node scripts/read-active-tab.js --check
   ```
   ```bash
   node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
   ```

   If relay is reachable this command waits for an active attachment instead of immediate failure.

4. Read default extraction from active tab:

   ```bash
   node scripts/read-active-tab.js --pretty false
   ```

5. Read full DOM:

   ```bash
   node scripts/read-active-tab.js \
     --expression "document.documentElement.outerHTML" --pretty false
   ```

6. Read WhatsApp messages (dry-run target):

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
- `Timed out waiting for Runtime.evaluate`: usually means no active attachment or an inactive target page.
- If attachment drops after tab changes, click the toolbar icon once and run `--check` again.
- If you see unstable behavior, audit processes:

```bash
npm run relay:status
```
- Single running relay instance is enforced by an OS lock; stale lock files are cleaned automatically.

## Reliability notes
- Controller commands are queued while extension reconnects and replayed after the relay sees the extension again.
- When the extension is ON (`ON` badge), it runs a reconnect loop: it keeps trying to re-establish relay socket and re-attach to the active tab automatically.
- The relay now tracks extension heartbeats (`Grais.extensionHeartbeat`) and closes stale extension connections.
- Request windows remain bounded by timeouts, so callers receive deterministic errors for retries instead of waiting indefinitely.

## Skill source of truth
- The repository root here is the source of truth for both this project and the installable skill.
- Do not edit installed copies under global skill directories directly. Update this folder, commit & push, then refresh globals by reinstalling from GitHub.
