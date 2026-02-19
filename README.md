# Grais Debugger Chrome Extension (Browser Relay)

Use this project to let Grais read data from the **attached Chrome tab** through a local relay.

## What runs where
- Extension (`extension/background.js`): attaches/detaches a chosen tab.
- Relay (`relay-server.js`): local bridge on `127.0.0.1:18792`.
- Reader (`scripts/read-active-tab.js`): executes reads and prints JSON.

## 1) Clone and install (recommended path)
Clone this repo under `~/codex`:

```bash
mkdir -p ~/codex
cd ~/codex
git clone git@github.com:Replypilot/grais-debug-relay.git
cd grais-debug-relay
npm install
```

If you use HTTPS instead of SSH:

```bash
git clone https://github.com/Replypilot/grais-debug-relay.git
```

## 2) One-time Chrome setup
1. Load extension in Chrome:
   - Open `chrome://extensions`
   - Enable Developer mode
   - Load unpacked from `~/codex/grais-debug-relay/extension`
   - Pin Grais Debugger icon

## 3) Start a session (always this order)
1. Start relay:

```bash
cd ~/codex/grais-debug-relay
npm run relay:start
```

2. Confirm relay is up:

```bash
npm run relay:status
```

Expected:
- `ok: true`
- `extensionConnected: true` after you complete the attach step below

3. Human attach step (required for agent runs):
   - Open/focus target tab in Chrome
   - Click Grais Debugger icon on that tab to attach it
   - Confirm badge shows `ON`
   - Tell agent when done

4. Verify attach before any read:

```bash
node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
```

Continue only when this command succeeds.

Note:
- Reads target the currently attached tab.
- If attach state drifts (for example after reconnect/reload), click the icon on the intended tab and run the check command again.

## 4) Read data
Default structured payload (`url`, `title`, `text`, `links`, `metaDescription`):

```bash
node scripts/read-active-tab.js --pretty false
```

Full DOM:

```bash
node scripts/read-active-tab.js --expression "document.documentElement.outerHTML" --pretty false
```

WhatsApp messages:

```bash
node scripts/read-active-tab.js \
  --preset whatsapp-messages \
  --selector "#main [data-testid=\"conversation-panel-messages\"], #main" \
  --max-messages 200 \
  --pretty false
```

## 5) Relay lifecycle
Status:

```bash
npm run relay:status
```

Stop:

```bash
npm run relay:stop
```

Notes:
- `relay:start` auto-stops after 2 hours by default.
- Override: `node scripts/relay-manager.js start --auto-stop-ms 10800000`
- Disable auto-stop: `node scripts/relay-manager.js start --auto-stop-ms 0`

## 6) Troubleshooting
- Relay unreachable:

```bash
npm run relay:status
```

- Extension bridge disconnected (`extensionConnected: false`):
  - Re-focus target tab
  - Click extension icon again
  - Re-run `npm run relay:status`
  - Re-run check command

- `Timed out waiting for Runtime.evaluate`:
  - Tab is usually not attached
  - Re-attach and re-run:

```bash
node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
```

- Clean restart:

```bash
npm run relay:stop
npm run relay:start
```
