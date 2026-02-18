---
name: grais-tab-webdata-reader
description: Read metadata and DOM payloads from an attached Chrome tab through a local Grais relay extension.
---

# Grais Tab Webdata Reader

Use this skill to attach to the active Chrome tab through the bundled Grais Debugger extension and extract tab metadata or DOM data for analysis.

## Quick start

1. Install dependencies and start relay

   ```bash
   npm install
   npm run relay:start
   ```

2. Load extension from this folder in Chrome

   - `chrome://extensions`
   - Enable developer mode
   - Load unpacked from this repo root

3. Attach the extension to the target tab (click toolbar icon)

4. Check readiness and attach state

   ```bash
   node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
   ```

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
- Preset extraction for WhatsApp and generic chat-auditing with regex filters.
- Attach-state polling with `--check --wait-for-attach`.

## Presets and filters

- `--preset` values: `default`, `whatsapp`, `wa`, `whatsapp-messages`, `chat-audit`, `chat`.
- Regex filters: `--text-regex`, `--exclude-text-regex`, `--link-text-regex`, `--link-href-regex`.
- WhatsApp/chat filters: `--message-regex`, `--exclude-message-regex`, `--sender-regex`, `--exclude-sender-regex`.

## Common command examples

```bash
node scripts/read-active-tab.js --pretty false
node scripts/read-active-tab.js --expression "document.documentElement.outerHTML"
node scripts/read-active-tab.js --preset whatsapp-messages --max-messages 200 --selector "#main"
node scripts/read-active-tab.js --preset chat-audit --selector "body" --message-regex ".*"
```

## Recommended flow with agents

Before fetching data in an automation flow, run a lightweight preflight once to ensure relay + attached tab state are ready.
