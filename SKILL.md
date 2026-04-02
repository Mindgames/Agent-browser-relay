---
name: agent-browser-relay
description: Read metadata and DOM payloads from an attached Chrome tab through a local Agent Browser Relay extension.
---

# Agent Browser Relay

Use this skill to attach to a chosen Chrome tab through the bundled Agent Browser Relay extension and extract tab metadata or DOM data for analysis.

## Quick start

Fresh-machine rule:
- `skills add` guarantees the installed skill at `~/.agents/skills/agent-browser-relay`
- the guaranteed Chrome load path after `skills add` is `~/.agents/skills/agent-browser-relay/extension`
- `~/agent-browser-relay/extension` is only an optional visible convenience copy created by `npm run extension:install`
- `npm run extension:path`, `npm run relay:start`, and `npm run relay:global:install` print the primary folder to load
- `npm run extension:path` also prints stable absolute paths for `read-active-tab.js` and `preflight.sh` so agents can avoid cwd-dependent invocation
- opening the extension popup once after relay startup now wakes the extension and lets `npm run extension:status` confirm that Chrome actually loaded it
- on a new machine, the human must load the primary path in `chrome://extensions` before attach/read steps. Do not treat a missing visible convenience copy as a sandbox or socket-permission issue.

Defaults are set in code:
- Host: `127.0.0.1`
- Port: `18793`
- Attach timeout: `120000` ms
Override per command with `--host`, `--port`, and `--attach-timeout-ms` when needed.

1. Install dependencies and start relay

   This prints the primary Chrome extension path to load in Chrome and refreshes the optional visible convenience copy when possible.

   ```bash
   npm run relay:start -- --status-timeout-ms 3000
   ```

   Or pin host/port explicitly:

   ```bash
   npm run relay:start -- --host "127.0.0.1" --port "18793" --status-timeout-ms 3000
   ```

   `relay:start` keeps running until you stop it or the process is restarted. If you want a bounded session, pass `--auto-stop-ms` explicitly:

   ```bash
   node scripts/relay-manager.js start --auto-stop-ms 10800000
   ```

2. Load extension in Chrome

   - `chrome://extensions`
   - Enable developer mode
   - Load unpacked from `~/.agents/skills/agent-browser-relay/extension` after `skills add`
   - If the command printed the extension path, treat that printed path as the source of truth
   - Run `npm run extension:path` from the installed skill directory any time you want the exact path printed again
   - `~/agent-browser-relay/extension` is optional; create it with `npm run extension:install` if you want a visible shortcut

3. Confirm the extension is loaded in Chrome

   Open the toolbar popup once after relay is running. The popup should show `Relay connected on <port>`.

   Agent requirement: before any attach step on a fresh machine, ask the human to open the popup once, then confirm:

   ```bash
   npm run extension:status -- --wait-for-connected --connected-timeout-ms 120000
   ```

4. Attach the extension to the target tab (open toolbar popup and click attach)

   Optional per-tab relay: in the popup, set **Tab port** before clicking attach if this tab should use a non-default relay port.
   If you want the agent to create its own first background tab instead, enable **Allow agent to create new background tabs** in the popup.

   Agent requirement: after `extension:status` confirms Chrome loaded the extension, pause and ask the human to do this attach step, then wait for confirmation before continuing.

   If your `.agents` skill folder drops `extension/` after a `git fetch` or pull, repair it from the repo:

   ```bash
   cd ~/.agents/skills/agent-browser-relay 2>/dev/null || cd ~/.agents/skills/private/agent-browser-relay
   git sparse-checkout disable
   git config --unset-all core.sparseCheckout || true
   git config --unset-all core.sparseCheckoutCone || true
   git checkout -- .
   ```

5. Check readiness and attach state

   ```bash
   npm run relay:doctor -- --port "18793" --tab-id "<TAB_ID>" --json
   ```

   Resolve `<TAB_ID>` from status first (`npm run relay:status -- --all --status-timeout-ms 3000`).
   For all agent runs, use the assigned tab id:

   ```bash
   npm run relay:doctor -- --host "127.0.0.1" --port "18793" --tab-id "<TAB_ID>" --json
   ```

   Continue only if this command returns success.

### Per-tab relay port behavior
- If you run one relay process with multiple ports, the extension can manage different relay ports per attached tab.
- A tab with no saved relay-port mapping uses the global default relay port (`18793`).
- After a successful attach, the extension saves that tab’s mapped relay port and reuses it automatically.
- Closed tabs have their mapping removed automatically.


## Mandatory behavior for agents
- Use fixed commands from this repo. Do not try to "discover" alternate script names.
- Gateway-only rule: always communicate through the local relay gateway (`/status` and `node scripts/read-active-tab.js`).
- Never use direct browser-control tooling for this workflow (for example Playwright, Puppeteer, Selenium, `agent-browser`, or ad-hoc Chrome control scripts).
- Never take control of a random Chrome window/profile. Only operate on the explicitly attached target tab leased via `--tab-id`.
- On a fresh machine, explicitly tell the human to load the primary extension path from `npm run extension:path` before any attach/read attempt. After `skills add`, that is normally `~/.agents/skills/agent-browser-relay/extension`.
- Canonical commands:
  - `npm run extension:path`
  - `npm run extension:status`
  - `npm run relay:start`
  - `npm run relay:status`
  - `npm run relay:doctor`
  - `npm run relay:stop`
  - `node scripts/read-active-tab.js`
- For relay health checks, always use explicit timeouts to avoid hangs:
  - `npm run relay:status -- --status-timeout-ms 3000`
  - `curl --max-time 3 -sS "http://127.0.0.1:18793/status"`
  - `npm run relay:status -- --all --status-timeout-ms 3000`
- After `relay:start`, pause and ask the human to open the popup once so `npm run extension:status -- --wait-for-connected --connected-timeout-ms 120000` can confirm Chrome actually loaded the extension.
- Only after `extension:status` succeeds, either ask the human to attach the target tab before reads, or confirm that **Allow agent to create new background tabs** is enabled before first-tab creation workflows.
- Run `npm run relay:doctor -- --host "127.0.0.1" --port "18793" --tab-id "<TAB_ID>" --json` before reads and proceed only when it succeeds.
- If the workflow will open tabs via `Target.createTarget`, run `npm run relay:doctor -- --host "127.0.0.1" --port "18793" --require-target-create --json` and proceed only when it succeeds.
- For all agent runs (single-agent and concurrent), always pass `--tab-id <tabId>` on check/read commands so every operation is lease-scoped.
- In concurrent runs, attached tabs are shared extension state, but an attached tab can only have one active lease at a time. Inspect `npm run relay:status -- --all --status-timeout-ms 3000` and prefer `leaseSummary.availableAttachedTabIds` or `attachedTabs[].leasedSessionId` when choosing the next `--tab-id`.
- If doctor returns `TAB_LEASED_BY_OTHER_SESSION`, do not attempt takeover. Wait for that session to finish or retry with another attached tab that has no active lease.
- When `Target.createTarget` is enabled, the extension may create and auto-attach the first agent-controlled tab for the session without a human seed attach step.
- Do not stop/restart relay during the task unless the human requests it or recovery is explicitly required.
- Do not restart relay only because code was updated locally; updates are applied on next explicit human-approved restart.
- If the requested `tabId` is missing from relay status `attachedTabs`, stop and ask the human to re-attach the target tab in the popup before continuing.
- If `relay:start` times out, report the actual relay log/error. Do not guess about sandbox restrictions unless the command output shows a concrete permission error.
- If the page shows human-verification gates (for example "Are you human?" or CAPTCHA), stop immediately, alert the human with [$attention-please](/Users/mathiasasberg/.codex/skills/public/attention-please/SKILL.md), and wait for explicit human confirmation before continuing.

5. Read structured tab payload

   ```bash
   node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --tab-id "<TAB_ID>"
   ```

6. Optional one-command smoke test

   ```bash
   ./scripts/preflight.sh
   ```

If the current working directory is not the installed skill root, use the absolute `Stable read CLI path` printed by `npm run extension:path` instead of a relative `node scripts/read-active-tab.js` path.

## Capabilities

`read-active-tab.js` returns capability metadata in every successful payload under:

`source.capabilities`

Version compatibility checks are also included under `source.extension`:
- `installedVersion`
- `sourceVersion`
- `relayVersion`
- `observedExtensionVersion`
- `versionMismatch`

If a mismatch is detected, the command also prints a human-friendly update hint to stderr on every run.

- `scripts/read-active-tab.js` default extraction: `url`, `title`, `text`, `links`, `metaDescription`.
- Relay session leases (`--tab-id`) for concurrent agent isolation per tab on one relay port.
- `Runtime.evaluate` expression mode with `--expression`, `--expression-file`, or `--expression-stdin`.
- Screenshot capture mode via `--screenshot` (optional `--screenshot-full-page`, `--screenshot-path`).
- Preset extraction for WhatsApp and generic chat-auditing with regex filters.
- Attach-state polling with `--check --wait-for-attach`.

## Concurrent workflow notes

- Inspect `npm run relay:status -- --all --status-timeout-ms 3000` before selecting a tab for a concurrent run.
- Use `attachedTabs` plus `leasedSessionId` / `tabLeases` to understand which attached tabs are currently free.
- If doctor returns `TAB_LEASED_BY_OTHER_SESSION`, do not force takeover. Wait for that session to release the tab or pick another attached `tabId`.
- Lease isolation scopes relay command routing per attached tab. It does not imply a separate browser profile or stronger browser-process isolation.

## Presets and filters

- `--preset` values: `default`, `whatsapp`, `wa`, `whatsapp-messages`, `chat-audit`, `chat`.
- Regex filters: `--text-regex`, `--exclude-text-regex`, `--link-text-regex`, `--link-href-regex`.
- WhatsApp/chat filters: `--message-regex`, `--exclude-message-regex`, `--sender-regex`, `--exclude-sender-regex`.

## Common command examples

In agent workflows, use the `--tab-id` variants. Unscoped commands are for manual/local debugging only.
Prefer `--expression-file` or `--expression-stdin` over inline `--expression` for non-trivial JavaScript.

```bash
node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --pretty false
node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --tab-id 123 --pretty false
node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --tab-id 123 --check --wait-for-attach --require-target-create --attach-timeout-ms 120000
node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --expression "document.documentElement.outerHTML"
node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --tab-id 123 --expression-file "./tmp/expression.js"
node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --tab-id 123 --expression-stdin < ./tmp/expression.js
node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --screenshot --screenshot-full-page --screenshot-path "./tmp/page.png"
node scripts/read-active-tab.js --host "127.0.0.1" --port "18793" --preset whatsapp-messages --max-messages 200 --selector "#main"
node scripts/read-active-tab.js --preset chat-audit --selector "body" --message-regex ".*"
```

All successful commands return a `source` object with `relayHost`, `relayPort`, `relayStatusUrl`, and `relayWebSocketUrl`.

## Recommended flow with agents

Before fetching data in an automation flow, run a lightweight preflight once to ensure relay + attached tab state are ready.

For multiple agents on one relay:
- Resolve tab ids from relay status (`npm run relay:status -- --all --status-timeout-ms 3000`).
- Assign one tab id per agent.
- Use `--tab-id` in every `read-active-tab.js` call for that agent.
- Treat the extension instance as shared: leases prevent two controller sessions from driving the same attached tab, but they do not create separate Chrome profiles or separate extension processes.
- If `relay:doctor` reports `TAB_LEASED_BY_OTHER_SESSION`, inspect `attachedTabs`, `tabLeases`, and blocker `detail`, then pick another attached tab or wait for the owning session to release it.
