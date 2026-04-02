#!/usr/bin/env node
'use strict'

const http = require('node:http')
const { refreshInstallBundle, describeInstallBundleFailure } = require('./extension-install-helper')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18793
const DEFAULT_STATUS_TIMEOUT_MS = 1200
const DEFAULT_CONNECTED_TIMEOUT_MS = 10000
const DEFAULT_CONNECTED_POLL_MS = 500

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printUsage()
  process.exit(0)
}

const host = String(args.host || DEFAULT_HOST).trim() || DEFAULT_HOST
const port = parsePort(args.port || DEFAULT_PORT)
const statusTimeoutMs = parsePositiveInt(args.statusTimeoutMs, DEFAULT_STATUS_TIMEOUT_MS, 'status-timeout-ms')
const connectedTimeoutMs = parsePositiveInt(
  args.connectedTimeoutMs,
  DEFAULT_CONNECTED_TIMEOUT_MS,
  'connected-timeout-ms',
)
const connectedPollMs = parsePositiveInt(args.connectedPollMs, DEFAULT_CONNECTED_POLL_MS, 'connected-poll-ms')
const relayStatusUrl = `http://${host}:${port}/status?all=true`

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

async function main() {
  const installBundle = refreshInstallBundle(() => {}, {
    prepareVisible: false,
    printHint: false,
  })

  if (installBundle.sourceMissing) {
    console.error(describeInstallBundleFailure(installBundle))
    process.exit(1)
    return
  }

  const status = args.waitForConnected
    ? await waitForExtensionConnection()
    : await getExtensionConnectionStatus()

  const payload = {
    ok: Boolean(status.relayReachable && status.extensionConnected),
    host,
    port,
    relayStatusUrl,
    relayReachable: status.relayReachable,
    extensionConnected: status.extensionConnected,
    extensionPorts: status.extensionPorts,
    activePorts: status.activePorts,
    extensionLastSeenAgoMs: status.extensionLastSeenAgoMs,
    extensionVersion: status.extensionVersion,
    extensionName: status.extensionName,
    browser: status.browser,
    primaryExtensionPath: installBundle.path,
    primaryPathKind: installBundle.pathKind,
    visibleExtensionPath: installBundle.visiblePath,
    visiblePathReady: installBundle.visiblePathReady,
    visiblePathNeedsRefresh: installBundle.visiblePathNeedsRefresh,
    waitedForConnection: Boolean(args.waitForConnected),
    connectedTimeoutMs: args.waitForConnected ? connectedTimeoutMs : null,
    error: status.error || null,
  }

  if (args.json) {
    console.log(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    printSummary(payload)
  }

  if (!payload.ok) {
    process.exitCode = 1
  }
}

async function waitForExtensionConnection() {
  const deadline = Date.now() + connectedTimeoutMs
  let lastStatus = null

  while (Date.now() <= deadline) {
    lastStatus = await getExtensionConnectionStatus()
    if (lastStatus.relayReachable && lastStatus.extensionConnected) {
      return lastStatus
    }
    if (Date.now() >= deadline) break
    await sleep(connectedPollMs)
  }

  return {
    ...(lastStatus || {}),
    relayReachable: Boolean(lastStatus?.relayReachable),
    extensionConnected: false,
    error:
      lastStatus?.error ||
      `Timed out waiting ${connectedTimeoutMs}ms for the Chrome extension to connect to relay port ${port}.`,
  }
}

function sanitizeBrowserIdentity(value) {
  if (!value || typeof value !== 'object') return null
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : null
  const family = typeof value.family === 'string' && value.family.trim() ? value.family.trim() : null
  const version = typeof value.version === 'string' && value.version.trim() ? value.version.trim() : null
  const profileId = typeof value.profileId === 'string' && value.profileId.trim() ? value.profileId.trim() : null
  if (!name && !family && !version && !profileId) return null
  return { name, family, version, profileId }
}

function formatBrowserIdentity(browser) {
  if (!browser) return null
  const label = [browser.name, browser.version].filter(Boolean).join(' ')
  if (browser.profileId) {
    return label ? `${label} (profile ${browser.profileId})` : `profile ${browser.profileId}`
  }
  return label || null
}

async function getExtensionConnectionStatus() {
  try {
    const response = await requestJson(relayStatusUrl, statusTimeoutMs)
    const ports = Array.isArray(response?.ports) ? response.ports : []
    const targetPort = ports.find((entry) => Number(entry?.port) === port) || null
    const extensionPorts = Array.isArray(response?.extensionPorts)
      ? response.extensionPorts.filter((value) => Number.isInteger(Number(value))).map((value) => Number(value))
      : ports.filter((entry) => entry?.extensionConnected === true).map((entry) => Number(entry.port))

    return {
      relayReachable: true,
      extensionConnected: Boolean(targetPort?.extensionConnected),
      extensionPorts,
      activePorts: Number.isFinite(Number(response?.activePorts))
        ? Number(response.activePorts)
        : extensionPorts.length,
      extensionLastSeenAgoMs: Number.isFinite(Number(targetPort?.extensionLastSeenAgoMs))
        ? Number(targetPort.extensionLastSeenAgoMs)
        : null,
      extensionVersion: typeof targetPort?.extensionVersion === 'string' ? targetPort.extensionVersion : null,
      extensionName: typeof targetPort?.extensionName === 'string' ? targetPort.extensionName : null,
      browser: sanitizeBrowserIdentity(targetPort?.browser),
      error: null,
    }
  } catch (error) {
    return {
      relayReachable: false,
      extensionConnected: false,
      extensionPorts: [],
      activePorts: 0,
      extensionLastSeenAgoMs: null,
      extensionVersion: null,
      extensionName: null,
      browser: null,
      error: `Relay is not reachable at ${relayStatusUrl}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function printSummary(payload) {
  console.log('Primary Chrome extension path:')
  console.log(`  ${payload.primaryExtensionPath}`)
  console.log(`Primary path source: ${describePrimaryPath(payload.primaryPathKind)}`)
  console.log(`Relay status URL: ${payload.relayStatusUrl}`)

  if (!payload.relayReachable) {
    console.log('Relay status: not reachable')
    console.log(payload.error)
    console.log('Start the relay first with `npm run relay:start` or `npm run relay:global:install`.')
    return
  }

  if (payload.extensionConnected) {
    const browserLabel = formatBrowserIdentity(payload.browser)
    console.log(
      browserLabel
        ? `Relay status: extension connected on port ${payload.port} via ${browserLabel}`
        : `Relay status: Chrome extension connected on port ${payload.port}`,
    )
    if (payload.extensionLastSeenAgoMs !== null) {
      console.log(`Last heartbeat: ${payload.extensionLastSeenAgoMs}ms ago`)
    }
    if (payload.extensionVersion) {
      console.log(`Extension version: ${payload.extensionVersion}`)
    }
    if (payload.browser?.family) {
      console.log(`Browser family: ${payload.browser.family}`)
    }
    return
  }

  console.log(`Relay status: Chrome extension is not connected on port ${payload.port}`)
  if (payload.extensionPorts.length > 0) {
    console.log(`Extension is currently connected on other relay port(s): ${payload.extensionPorts.join(', ')}`)
  }
  console.log('This means Chrome has not confirmed the extension in the current browser profile yet, or the popup has not been opened since relay startup.')
  console.log('Open Chrome, verify Agent Browser Relay is enabled, then open the toolbar popup once.')
  console.log('The popup now wakes the extension and should show a relay-connected status when the load is confirmed.')
  console.log('If this is first run and the extension is missing from Chrome, load unpacked from the primary path above.')
  console.log('Re-run this command, or use `npm run extension:status -- --wait-for-connected --connected-timeout-ms 120000`.')
  if (payload.error) {
    console.log(payload.error)
  }
}

function describePrimaryPath(kind) {
  if (kind === 'global-skill') return 'global skills install'
  if (kind === 'private-skill') return 'Codex compatibility install'
  return 'current checkout'
}

function requestJson(url, timeoutMs = 1000) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: 'http:',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += String(chunk || '')
        })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(body || '{}'))
          } catch {
            reject(new Error('Invalid JSON from relay'))
          }
        })
      },
    )
    req.end()
    req.on('error', (error) => {
      reject(error)
    })
    req.on('timeout', () => {
      req.destroy(new Error('HTTP timeout'))
    })
  })
}

function parseArgs(argv) {
  const out = {
    help: false,
    json: false,
    waitForConnected: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--host' && argv[i + 1]) out.host = argv[++i]
    else if (arg === '--port' && argv[i + 1]) out.port = argv[++i]
    else if (arg === '--status-timeout-ms' && argv[i + 1]) out.statusTimeoutMs = argv[++i]
    else if (arg === '--connected-timeout-ms' && argv[i + 1]) out.connectedTimeoutMs = argv[++i]
    else if (arg === '--connected-poll-ms' && argv[i + 1]) out.connectedPollMs = argv[++i]
    else if (arg === '--wait-for-connected') out.waitForConnected = true
    else if (arg === '--json') out.json = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return out
}

function parsePositiveInt(value, fallback, label) {
  const parsed = Number.parseInt(String(value || fallback), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${String(value)} (must be positive integer)`)
  }
  return parsed
}

function parsePort(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_PORT), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port: ${String(value)} (must be 1-65535)`)
  }
  return parsed
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function printUsage() {
  console.log(`Usage:
  node scripts/extension-status.js [--host ${DEFAULT_HOST}] [--port ${DEFAULT_PORT}] [--status-timeout-ms 1200]
  node scripts/extension-status.js --wait-for-connected [--connected-timeout-ms 120000] [--connected-poll-ms 500]
  node scripts/extension-status.js --json
`)
}
