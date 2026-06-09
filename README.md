# Agent Browser Relay

Agent Browser Relay lets an AI agent read and inspect a Chrome tab that you explicitly attach. It keeps the agent inside your real browser session without giving it control of random windows or a separate automation profile.

Use it when an agent needs page text, links, DOM, screenshots, or selected browser context from authenticated pages.

## How It Works

1. A Chrome or Chromium extension lets you attach the tab you want the agent to use.
2. A local relay runs on `127.0.0.1:18793`.
3. One relay port can keep multiple browser/profile extension clients connected at once.
4. The agent calls the relay with a specific `--tab-id` or browser-scoped `--tab-ref`.
5. The relay reads only that attached tab and returns JSON.

The important safety rule is simple: no attached tab, no read.

## Requirements

- Google Chrome or another Chromium browser that can load unpacked extensions
- Node.js 20 or newer
- `pnpm`
- macOS or Linux for the global background relay service

## Install

Install from GitHub with `skills`:

```bash
npx skills add Mindgames/Agent-browser-relay -g -y
```

Or work from a local checkout:

```bash
git clone https://github.com/Mindgames/Agent-browser-relay.git
cd Agent-browser-relay
pnpm install
```

Print the exact extension and CLI paths:

```bash
pnpm extension:path
```

## Load The Chrome Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension` folder printed by `pnpm extension:path`.
5. Pin **Agent Browser Relay** in the Chrome toolbar.

Common extension paths:

```text
~/.agents/skills/agent-browser-relay/extension
~/.agents/skills/private/agent-browser-relay/extension
<local checkout>/extension
```

On macOS, press `Command+Shift+G` in the file picker to paste hidden paths like `~/.agents/...`.

## Start The Relay

Recommended always-on service:

```bash
pnpm relay:global:install -- --ports 18793 --timeout 12000
pnpm relay:global:status
```

One-off foreground/fallback mode:

```bash
pnpm relay:start
```

Check that Chrome has loaded and connected the extension:

```bash
pnpm extension:status -- --wait-for-connected --connected-timeout-ms 120000
```

## Attach A Tab

1. Open the target page in Chrome, Brave, Edge, or another Chromium browser.
2. Click the **Agent Browser Relay** toolbar icon.
3. Click **Attach this tab**.
4. Confirm the badge shows `ON`.
5. Copy the tab id from the popup, or get the tab id / tab ref from:

```bash
pnpm relay:status -- --all --status-timeout-ms 3000
```

## Read A Tab

Replace `<TAB_ID>` with the attached tab id. If more than one browser is connected and tab ids collide, use `<TAB_REF>` from `relay:status` instead. A tab ref is `browserId:tabId`.

Run the readiness check first:

```bash
pnpm relay:doctor -- --host "127.0.0.1" --port "18793" --tab-id "<TAB_ID>" --json
```

Or target a specific browser tab ref:

```bash
pnpm relay:doctor -- --host "127.0.0.1" --port "18793" --tab-ref "<TAB_REF>" --json
```

Read the default page payload:

```bash
node scripts/read-active-tab.js \
  --host "127.0.0.1" \
  --port "18793" \
  --tab-id "<TAB_ID>" \
  --pretty false
```

For duplicate tab ids across browsers:

```bash
node scripts/read-active-tab.js \
  --host "127.0.0.1" \
  --port "18793" \
  --tab-ref "<TAB_REF>" \
  --pretty false
```

The default payload includes:

- `url`
- `title`
- `text`
- `links`
- `metaDescription`

Read the full DOM:

```bash
node scripts/read-active-tab.js \
  --host "127.0.0.1" \
  --port "18793" \
  --tab-id "<TAB_ID>" \
  --expression "document.documentElement.outerHTML" \
  --pretty false
```

Take a full-page screenshot:

```bash
node scripts/read-active-tab.js \
  --host "127.0.0.1" \
  --port "18793" \
  --tab-id "<TAB_ID>" \
  --screenshot \
  --screenshot-full-page \
  --screenshot-path "./tmp/page.png" \
  --pretty false
```

For long JavaScript expressions, prefer `--expression-file` or `--expression-stdin` instead of shell-quoted inline code.

## Agent Prompt Example

```text
Use Agent Browser Relay to read tab 4581930 and summarize the page.
```

The agent should:

1. Check relay status.
2. Confirm the requested tab is attached.
3. Run `relay:doctor` for that `--tab-id` or `--tab-ref`.
4. Read only that tab.

## Agent Safety Contract

Agents must use the local relay gateway only:

- `/status`
- `pnpm relay:status -- --all --status-timeout-ms 3000`
- `pnpm relay:doctor -- --tab-id "<TAB_ID>" --json`
- `pnpm relay:doctor -- --tab-ref "<TAB_REF>" --json`
- `node scripts/read-active-tab.js --tab-id "<TAB_ID>"`
- `node scripts/read-active-tab.js --tab-ref "<TAB_REF>"`

Agents must not use Playwright, Puppeteer, Selenium, ad-hoc Chrome scripts, or a random Chrome profile for this workflow.

If a page shows CAPTCHA or human verification, the agent must stop and wait for the human.

## Canonical Script Names

These script names are stable for automation. The `npm run ...` form is still documented because some agent instructions match exact command names, but this repo prefers `pnpm`.

```bash
npm run extension:path
npm run extension:status
npm run relay:global:install
npm run relay:global:status
npm run relay:global:start
npm run relay:global:stop
npm run relay:start
npm run relay:status
npm run relay:doctor
npm run relay:stop
node scripts/read-active-tab.js
```

## Troubleshooting

Relay is not connected:

```bash
pnpm relay:status -- --status-timeout-ms 3000
pnpm extension:status -- --wait-for-connected --connected-timeout-ms 120000
```

Tab is not attached:

1. Focus the tab in Chrome.
2. Open the extension popup.
3. Click **Attach this tab** again.
4. Re-run `pnpm relay:doctor -- --tab-id "<TAB_ID>" --json` or `pnpm relay:doctor -- --tab-ref "<TAB_REF>" --json`.

Another agent has the tab lease:

```bash
pnpm relay:status -- --all --status-timeout-ms 3000
```

Choose another attached tab or wait for the current lease to release. Do not force takeover.

Need a new background tab:

1. Enable **Allow agent to create new background tabs** in the extension popup.
2. Check readiness:

```bash
pnpm relay:doctor -- --host "127.0.0.1" --port "18793" --require-target-create --json
```

## Development

Install dependencies:

```bash
pnpm install
```

Run checks:

```bash
pnpm lint
pnpm build
pnpm test
```

Project layout:

```text
extension/                 Chrome extension
relay-server.js            Local relay server
scripts/read-active-tab.js Tab read/check CLI
scripts/relay-manager.js   Relay lifecycle and doctor checks
scripts/relay-service.js   Global service install/start/stop
SKILL.md                   Agent Browser Relay skill instructions
AGENTS.md                  Required agent operating contract
```

## License

Agent Browser Relay is open source under the MIT License.

The full license is also available in [`LICENSE`](./LICENSE).

```text
MIT License

Copyright (c) 2026 Mathias Asberg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
