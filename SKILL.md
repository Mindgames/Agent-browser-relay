---
name: grais-tab-webdata-reader
description: Read metadata and DOM payloads from an attached Chrome tab through a local Grais relay extension.
---

# Grais Tab Webdata Reader

Use this skill to attach to a chosen Chrome tab through the bundled Grais Debugger extension and extract tab metadata or DOM data for analysis.

## Quick start

1. Install dependencies and start relay

   ```bash
   npm install
   npm run relay:start
   ```

   `relay:start` auto-stops after 2 hours by default. Override if needed:

   ```bash
   node scripts/relay-manager.js start --auto-stop-ms 10800000
   node scripts/relay-manager.js start --auto-stop-ms 0
   ```

2. Load extension from the `extension/` subfolder in Chrome

   - `chrome://extensions`
   - Enable developer mode
   - Load unpacked from `~/.codex/skills/private/grais-tab-webdata-reader/extension`

3. Attach the extension to the target tab (open toolbar popup and click attach)

   Optional per-tab relay: in the popup, set **Tab port** before clicking attach if this tab should use a non-default relay port.

   Agent requirement: after `relay:start`, pause and ask the human to do this attach step, then wait for confirmation before continuing.

   If your `.codex` skill folder drops `extension/` after a `git fetch` or pull, repair it from the repo:

   ```bash
   cd ~/.codex/skills/private/grais-tab-webdata-reader
   git sparse-checkout disable
   git config --unset-all core.sparseCheckout || true
   git config --unset-all core.sparseCheckoutCone || true
   git checkout -- .
   ```

4. Check readiness and attach state

   ```bash
   node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
   ```

   Continue only if this command returns success.

   For multi-relay deployments, verify all ports at once:

   ```bash
   npm run relay:status -- --scan-ports 18792,18793,18794,18795,18796,18797,18798,18799,18800,18801,18802
   ```

## Mandatory behavior for agents
- Use fixed commands from this repo. Do not try to "discover" alternate script names.
- Canonical commands:
  - `npm run relay:start`
  - `npm run relay:status`
  - `npm run relay:stop`
  - `node scripts/read-active-tab.js`
- After `relay:start`, pause and ask the human to attach the target tab before any read.
- Run `node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000` before reads and proceed only when it succeeds.
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
