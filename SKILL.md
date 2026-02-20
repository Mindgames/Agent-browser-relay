---
name: grais-tab-webdata-reader
description: Read metadata and DOM payloads from an attached Chrome tab through a local Grais relay extension.
---

# Grais Tab Webdata Reader

Use this skill to attach to a chosen Chrome tab through the bundled Grais Debugger extension and extract tab metadata or DOM data for analysis.

## Quick start

Use these defaults for the active relay endpoint:

```bash
export GRAIS_RELAY_HOST=127.0.0.1
export GRAIS_RELAY_PORT=18793
export GRAIS_ATTACH_TIMEOUT_MS=120000
```

1. Wire canonical skill path

   ```bash
   npm run codex:install
   ```

2. Install dependencies and start relay

   ```bash
   npm run relay:start -- --status-timeout-ms 3000
   ```

   Or pin host/port explicitly:

   ```bash
   npm run relay:start -- --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --status-timeout-ms 3000
   ```

   `relay:start` auto-stops after 2 hours by default. Override if needed:

   ```bash
   node scripts/relay-manager.js start --auto-stop-ms 10800000
   node scripts/relay-manager.js start --auto-stop-ms 0
   ```

3. Load extension from the `extension/` subfolder in Chrome

   - `chrome://extensions`
   - Enable developer mode
   - Load unpacked from `~/.codex/skills/private/grais-tab-webdata-reader/extension`

4. Attach the extension to the target tab (click toolbar icon)

   Agent requirement: after `relay:start`, pause and ask the human to do this attach step, then wait for confirmation before continuing.

5. Check readiness and attach state

   ```bash
   node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --check --wait-for-attach --attach-timeout-ms "${GRAIS_ATTACH_TIMEOUT_MS:-120000}"
   ```

   Continue only if this command returns success.

## Mandatory behavior for agents
- Use fixed commands from this repo. Do not try to "discover" alternate script names.
- Canonical commands:
  - `npm run relay:start`
  - `npm run relay:status`
  - `npm run relay:stop`
  - `node scripts/read-active-tab.js`
- For relay health checks, always use explicit timeouts to avoid hangs:
  - `npm run relay:status -- --status-timeout-ms 3000`
  - `curl --max-time 3 -sS "http://${GRAIS_RELAY_HOST:-127.0.0.1}:${GRAIS_RELAY_PORT:-18793}/status"`
- After `relay:start`, pause and ask the human to attach the target tab before any read.
- Run `node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --check --wait-for-attach --attach-timeout-ms "${GRAIS_ATTACH_TIMEOUT_MS:-120000}"` before reads and proceed only when it succeeds.
- Do not stop/restart relay during the task unless the human requests it or recovery is explicitly required.

5. Read structured tab payload

   ```bash
   node scripts/read-active-tab.js
   ```

6. Optional one-command smoke test

   ```bash
   ./scripts/preflight.sh
   ```

## Capabilities

- `scripts/read-active-tab.js` default extraction: `url`, `title`, `text`, `links`, `metaDescription`.
- `Runtime.evaluate` expression mode with `--expression`.
- Screenshot capture mode via `--screenshot` (optional `--screenshot-full-page`, `--screenshot-path`).
- Preset extraction for WhatsApp and generic chat-auditing with regex filters.
- Attach-state polling with `--check --wait-for-attach`.

## Presets and filters

- `--preset` values: `default`, `whatsapp`, `wa`, `whatsapp-messages`, `chat-audit`, `chat`.
- Regex filters: `--text-regex`, `--exclude-text-regex`, `--link-text-regex`, `--link-href-regex`.
- WhatsApp/chat filters: `--message-regex`, `--exclude-message-regex`, `--sender-regex`, `--exclude-sender-regex`.

## Common command examples

```bash
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --pretty false
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --expression "document.documentElement.outerHTML"
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --screenshot --screenshot-full-page --screenshot-path "./tmp/page.png"
node scripts/read-active-tab.js --host "${GRAIS_RELAY_HOST:-127.0.0.1}" --port "${GRAIS_RELAY_PORT:-18793}" --preset whatsapp-messages --max-messages 200 --selector "#main"
node scripts/read-active-tab.js --preset chat-audit --selector "body" --message-regex ".*"
```

All successful commands return a `source` object with `relayHost`, `relayPort`, `relayStatusUrl`, and `relayWebSocketUrl`.

## Recommended flow with agents

Before fetching data in an automation flow, run a lightweight preflight once to ensure relay + attached tab state are ready.
