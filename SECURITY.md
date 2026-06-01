# Security Policy

## Supported Versions

Security fixes target the current `main` branch and the latest tagged release.

## Reporting a Vulnerability

Open a private security advisory on GitHub when possible. If that is not available, contact the maintainer through the GitHub profile linked in the README.

Please include:

- The affected version or commit.
- Reproduction steps.
- The expected browser, relay, and tab attachment state.
- Any proof-of-concept code needed to demonstrate the boundary issue.

## Security Model

Agent Browser Relay is designed for local, human-approved browser access:

- The relay listens on localhost by default.
- The extension can attach only after the human loads the extension and approves the target tab from the popup.
- Agent runs must use `--tab-id` so commands are scoped to an explicitly attached tab lease.
- The relay exposes CDP methods needed for page reads, screenshots, tab creation, and cleanup. Treat attached tabs as sensitive because they may contain authenticated sessions.
- If a page presents CAPTCHA or human verification, agents must stop and wait for human confirmation before continuing.

Do not expose the relay port to untrusted networks.
