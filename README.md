# Grais Debugger Chrome Extension (Browser Relay)

## Purpose
Bridge Chrome to Grais so an agent can run safe extraction commands against the **active tab**.

- Extension handles tab attach/detach and badge/status updates.
- Local relay exposes the attached tab through a websocket bridge.
- `grais-tab-webdata-reader` consumes the relay and returns extraction payloads as JSON.

## Capabilities
- Attach and detach active tab from toolbar icon.
- Recover attachment from active-tab events.
- Evaluate DOM scripts in-page via `Runtime.evaluate`.
- Default extraction:
  - `url`, `title`, `text`, `links`, `metaDescription`.
- Full DOM extraction using custom JS expression.
- WhatsApp chat mode:
  - `--preset whatsapp-messages` (alias: `whatsapp`, `wa`) with regex filtering for messages and senders.

## Quick setup

1. Install extension
   - Chrome → `chrome://extensions`
   - Enable Developer mode
   - Load unpacked folder: this repository
   - Pin Grais Debugger icon
2. Start relay

   ```bash
   cd /Users/mathiasasberg/Projects/grais/api+chrome/chrome-debugger
   npm install
   npm run relay:start
   ```

3. Open target tab and click extension icon once to attach.

Keep relay running in the background for the whole workflow session and stop it only when done:

```bash
cd /Users/mathiasasberg/Projects/grais/api+chrome/chrome-debugger
npm run relay:status
npm run relay:stop
```

## Readiness check (recommended before every DOM read)

1. Verify relay + extension heartbeat bridge:

```bash
curl -s http://127.0.0.1:18792/status
```

This should return JSON with:
- `extensionConnected: true`
- `queuedControllerCommands: 0` (or low during normal operation)

2. Then run tool check for active tab attachment:

```bash
node scripts/read-active-tab.js --check --wait-for-attach
```

## Preflight check (recommended)

Before any fetch:

```bash
node scripts/read-active-tab.js --check
```

For hands-off runs, you can wait until relay and extension attachment are both ready:

```bash
node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
```

Use this to verify both relay connectivity and active extension attachment.

## Example reads

Default extractor:

```bash
node scripts/read-active-tab.js --pretty false
```

Full DOM:

```bash
node scripts/read-active-tab.js \
  --expression "document.documentElement.outerHTML" \
  --pretty false
```

WhatsApp chat extraction:

```bash
node scripts/read-active-tab.js \
  --preset whatsapp-messages \
  --selector "#main [data-testid=\"conversation-panel-messages\"], #main" \
  --max-messages 200 \
  --sender-regex "Mathias|Judy" \
  --pretty false
```

- `--wait-for-attach` wait until relay+extension attachment is ready before running checks/fetches.
- `--attach-timeout-ms <ms>` maximum wait time (default: `120000`).
- `--attach-poll-ms <ms>` polling interval (default: `500`).

## Troubleshooting
- Red `!` badge: relay unreachable / not attached.
- Re-run `--check` after switching tabs.
- If needed, re-click the toolbar icon to trigger re-attach.
- If you see multiple relay processes, audit with:

```bash
npm run relay:status
```

- To force a clean restart, run:

```bash
npm run relay:stop
npm run relay:start
```

Reliability:
- The relay now keeps controller requests while the extension is reconnecting, then flushes them once the extension reattaches.
- When the extension is ON (`ON` badge), it keeps trying to reconnect to relay automatically and re-attaches the active tab when relay comes back.
- The extension sends heartbeat messages every few seconds; stale extension sessions are dropped and re-established automatically by user actions or next command flow.
- If a request waits for an unattached relay too long, it now fails with timeout instead of hanging indefinitely.
