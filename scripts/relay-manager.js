#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { describeInstallBundleFailure, refreshInstallBundle } = require('./extension-install-helper')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18793
const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_START_TIMEOUT_MS = 10000
const DEFAULT_START_POLL_MS = 250
const DEFAULT_STATUS_TIMEOUT_MS = 1200
const DEFAULT_AUTO_STOP_MS = 2 * 60 * 60 * 1000
const REPO_ROOT = path.resolve(fs.realpathSync(__dirname), '..')
const RELAY_FILE_PREFIX = 'grais-debugger-relay'
const ALLOWED_PORT_ACTIONS = ['add', 'remove']

const args = parseArgs(process.argv.slice(2))
const command = args.command
if (args.help) {
  printUsage()
  process.exit(0)
}

if (!command) {
  printUsage()
  process.exit(1)
}

const host = String(args.host || DEFAULT_HOST).trim() || DEFAULT_HOST
const relayPorts = parsePortList(args.ports || args.port, [DEFAULT_PORT])
const port = relayPorts[0]
const timeoutMs = parsePositiveInt(args.timeout, DEFAULT_TIMEOUT_MS, '--timeout')
const startTimeoutMs = parsePositiveInt(args.startTimeoutMs, DEFAULT_START_TIMEOUT_MS, '--start-timeout-ms')
const statusTimeoutMs = parsePositiveInt(
  args.statusTimeoutMs,
  DEFAULT_STATUS_TIMEOUT_MS,
  '--status-timeout-ms',
)
const autoStopMs = parseNonNegativeInt(args.autoStopMs, DEFAULT_AUTO_STOP_MS, '--auto-stop-ms')

const relayServerPath = path.join(REPO_ROOT, 'relay-server.js')
const relayStatePath = getRelayStatePath(host, port)
const relayLockPath = getRelayLockPath(host, port)

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

async function main() {
  if (command === 'start') {
    await startRelay()
    return
  }
  if (command === 'status') {
    await printStatus()
    return
  }
  if (command === 'stop') {
    await stopRelay()
    return
  }
  if (command === 'ports') {
    await updateRelayPorts()
    return
  }

  throw new Error(`Unknown command "${command}"`)
}

async function startRelay() {
  prepareVisibleExtensionBundle()

  const preCheck = await fetchRelayStatus(false)
  if (preCheck.ok) {
    const activePorts =
      Array.isArray(preCheck.extensionPorts) && preCheck.extensionPorts.length > 0 ? preCheck.extensionPorts : []
    const statusLabel = activePorts.length > 0 ? ` (extension active on ${activePorts.join(', ')})` : ''
    const state = readRelayState()
    const now = Date.now()
    const autoStopInMs =
      Number.isInteger(state?.autoStopAt) && state.autoStopAt > now ? state.autoStopAt - now : null
    const ttlLabel =
      autoStopInMs !== null
        ? ` (auto-stop in ${Math.ceil(autoStopInMs / 1000)}s)`
        : ''
    console.log(`Relay already reachable at http://${host}:${port}/status${statusLabel}${ttlLabel}`)
    await printExtensionConnectionGuidance()
    return
  }

  const relayPid = launchRelayProcess()
  const started = await waitFor(
    () => fetchRelayStatus(false).then((status) => status.ok === true),
    startTimeoutMs,
    DEFAULT_START_POLL_MS,
  )
  if (!started) {
    throw new Error(
      [
        `Relay did not become reachable at http://${host}:${port}/status within ${startTimeoutMs}ms.`,
        buildRelayLogHint(),
      ].join('\n'),
    )
  }

  const lockOwner = readRelayLock()
  const state = {
    pid: Number.parseInt(String(lockOwner?.pid || relayPid || ''), 10) || null,
    host,
    port,
    ports: relayPorts,
    startedAt: Date.now(),
    autoStopMs,
    autoStopAt: autoStopMs > 0 ? Date.now() + autoStopMs : null,
  }
  fs.writeFileSync(relayStatePath, JSON.stringify(state, null, 2))

  const pidLabel = state.pid ? ` (server pid: ${state.pid})` : ''
  const ttlLabel =
    autoStopMs > 0 ? ` (auto-stop in ${Math.ceil(autoStopMs / 1000)}s)` : ' (auto-stop disabled)'
  console.log(`Relay started in background at http://${host}:${port}/status${pidLabel}${ttlLabel}`)
  await printExtensionConnectionGuidance()
}

function prepareVisibleExtensionBundle() {
  let result
  try {
    result = refreshInstallBundle((message) => {
      console.error(`[agent-browser-relay] ${message}`)
    })
  } catch (error) {
    console.warn(
      [
        `[agent-browser-relay] Failed to prepare the optional visible extension folder: ${error instanceof Error ? error.message : String(error)}`,
        'Relay startup will continue, but the optional visible Chrome extension folder may be stale or missing.',
      ].join(' '),
    )
    return null
  }
  if (!result || result.ok !== true) {
    console.warn(
      [
        describeInstallBundleFailure(result),
        'Relay startup will continue, but the optional visible Chrome extension folder may be stale or missing.',
      ].join(' '),
    )
    return result
  }
  return result
}

async function updateRelayPorts() {
  const action = String(args.action || '').trim().toLowerCase()
  const requestedPorts = parsePortList(args.ports || args.port, [])

  if (!action || !ALLOWED_PORT_ACTIONS.includes(action)) {
    throw new Error(`Unknown ports action "${action}". Use --action add|remove`)
  }
  if (requestedPorts.length === 0) {
    throw new Error('No valid --ports provided')
  }

  const response = await requestJson(`http://${host}:${port}/admin/ports`, statusTimeoutMs, {
    method: 'POST',
    body: {
      action,
      ports: requestedPorts,
    },
  })
  if (response && response.ok === false) {
    throw new Error(`Port update failed: ${response.error || 'unknown'}`)
  }

  console.log(JSON.stringify(response, null, 2))
}

async function stopRelay() {
  const managedPids = []

  const state = readRelayState()
  if (Number.isInteger(state?.pid)) managedPids.push(state.pid)

  const lockOwner = readRelayLock()
  if (Number.isInteger(lockOwner?.pid)) managedPids.push(lockOwner.pid)

  const uniquePids = [...new Set(managedPids.filter((value) => Number.isFinite(value) && value > 0))]

  if (uniquePids.length === 0) {
    const running = await fetchRelayStatus(false)
    if (!running.ok) {
      cleanupManagerState()
      console.log(`Relay is not reachable on ${host}:${port}.`)
      return
    }
    throw new Error(`Relay is reachable on ${host}:${port}, but no managed pid was found. Stop it from your process manager.`)
  }

  for (const pid of uniquePids) {
    if (!isProcessAlive(pid)) continue
    await stopProcess(pid, 2000)
  }

  await waitFor(() => fetchRelayStatus(false).then((s) => s.ok === false), 2000, 100)
  cleanupManagerState()
  console.log(`Relay stop requested for pid(s): ${uniquePids.join(', ')}`)
}

async function printStatus() {
  const status = await fetchRelayStatus(false, { all: args.all === true })
  if (!status.ok) {
    console.log(JSON.stringify({ ok: false, reason: 'Relay not reachable', host, port }, null, 2))
    return
  }

  const lockOwner = readRelayLock()
  const state = readRelayState()
  const payload = {
    ok: true,
    host,
    port,
    ports: Array.isArray(status.ports) ? status.ports : [],
    service: status.service,
    extensionConnected:
      status.extensionConnected === true || (Array.isArray(status.extensionPorts) && status.extensionPorts.length > 0),
    extensionPorts: status.extensionPorts || [],
    extensionLastSeenAgoMs: Number.isFinite(status.extensionLastSeenAgoMs) ? status.extensionLastSeenAgoMs : null,
    activePorts: Number.isFinite(status.activePorts) ? status.activePorts : (status.extensionPorts || []).length,
    queuedControllerCommands:
      Number.isFinite(status.queuedControllerCommands) ? status.queuedControllerCommands : 0,
    lockPid: lockOwner?.pid ?? null,
    managerPid: state?.pid ?? null,
    autoStopMs: Number.isInteger(state?.autoStopMs) ? state.autoStopMs : null,
    autoStopAt: Number.isInteger(state?.autoStopAt) ? state.autoStopAt : null,
    autoStopInMs:
      Number.isInteger(state?.autoStopAt) && state.autoStopAt > Date.now() ? state.autoStopAt - Date.now() : null,
  }
  console.log(JSON.stringify(payload, null, 2))
}

async function printExtensionConnectionGuidance() {
  const status = await fetchRelayStatus(false, { all: true })
  if (!status.ok) return

  const targetPorts = Array.isArray(status.ports) ? status.ports : []
  const target = targetPorts.find((entry) => Number(entry?.port) === port) || null
  if (target?.extensionConnected === true) {
    console.log(`[agent-browser-relay] Chrome extension is connected on relay port ${port}.`)
    return
  }

  const extensionPorts = Array.isArray(status.extensionPorts)
    ? status.extensionPorts.filter((value) => Number.isInteger(Number(value))).map((value) => Number(value))
    : []
  const portHint = extensionPorts.length > 0
    ? ` It is currently connected on other port(s): ${extensionPorts.join(', ')}.`
    : ''

  console.warn(
    [
      `[agent-browser-relay] Relay is up, but Chrome extension load is not confirmed on port ${port}.${portHint}`,
      'Open the Agent Browser Relay popup once in Chrome to wake the extension, then run:',
      `[agent-browser-relay]   npm run extension:status -- --port "${port}" --status-timeout-ms ${statusTimeoutMs}`,
    ].join('\n'),
  )
}

function launchRelayProcess() {
  const logPath = getRelayLogPath(host, port)
  const logHandle = fs.openSync(logPath, 'a')
  const relayArgs = [relayServerPath, '--host', host, '--timeout', String(timeoutMs)]
  if (relayPorts.length === 1) {
    relayArgs.push('--port', String(relayPorts[0]))
  } else {
    relayArgs.push('--ports', relayPorts.join(','))
  }
  if (autoStopMs > 0) {
    relayArgs.push('--max-runtime-ms', String(autoStopMs))
  }
  const child = spawn(
    process.execPath,
    relayArgs,
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', logHandle, logHandle],
    },
  )
  child.unref()
  fs.closeSync(logHandle)

  if (!child.pid) {
    throw new Error('Failed to start relay process')
  }

  return child.pid
}

async function stopProcess(pid, gracefulMs) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error
    return
  }

  const deadline = Date.now() + gracefulMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await sleep(50)
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error
  }
}

function cleanupManagerState() {
  try {
    fs.unlinkSync(relayStatePath)
  } catch {
    // best effort
  }
}

function buildRelayLogHint() {
  const logPath = getRelayLogPath(host)
  const logTail = readRelayLogTail(logPath)
  if (!logTail) {
    return `Check relay log: ${logPath}`
  }
  return `Recent relay log (${logPath}):\n${logTail}`
}

function readRelayLogTail(logPath, maxLines = 40, maxChars = 4000) {
  try {
    const raw = fs.readFileSync(logPath, 'utf8').trim()
    if (!raw) return ''
    const lines = raw.split(/\r?\n/).slice(-maxLines)
    const joined = lines.join('\n')
    if (joined.length <= maxChars) return joined
    return joined.slice(joined.length - maxChars)
  } catch {
    return ''
  }
}

function waitFor(predicate, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const poll = async () => {
      try {
        const status = await predicate()
        if (status) {
          resolve(status)
          return
        }
      } catch {
        // ignore
      }

      if (Date.now() >= deadline) {
        resolve(false)
        return
      }

      setTimeout(poll, intervalMs)
    }

    void poll()
  })
}

async function fetchRelayStatus(throwOnError = true, options = {}) {
  const query = options.all === true ? '?all=true' : ''
  try {
    const response = await requestJson(`http://${host}:${port}/status${query}`, statusTimeoutMs)
    return {
      ok: true,
      ...(typeof response === 'object' && response ? response : {}),
    }
  } catch (error) {
    if (throwOnError) throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function requestJson(url, timeoutMs = 1000, reqOptions = {}) {
  const method = String(reqOptions.method || 'GET').toUpperCase()
  const bodyPayload = reqOptions.body
  const bodyText = bodyPayload === undefined ? '' : JSON.stringify(bodyPayload)
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: 'http:',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        timeout: timeoutMs,
        headers: bodyText
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(bodyText),
            }
          : undefined,
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
    if (bodyText) req.write(bodyText)
    req.end()

    req.on('error', (error) => {
      reject(error)
    })
    req.on('timeout', () => {
      req.destroy(new Error('HTTP timeout'))
    })
  })
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isNoSuchProcess(error) {
  return error && error.code === 'ESRCH'
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function readRelayLock() {
  try {
    const raw = fs.readFileSync(relayLockPath, 'utf8').trim()
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const pid = Number.parseInt(String(parsed?.pid), 10)
    return Number.isInteger(pid) ? { pid } : null
  } catch {
    return null
  }
}

function readRelayState() {
  try {
    const raw = fs.readFileSync(relayStatePath, 'utf8')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const pid = Number.parseInt(String(parsed?.pid), 10)
    return Number.isInteger(pid) ? { ...parsed, pid } : null
  } catch {
    return null
  }
}

function getRelayStatePath(hostname) {
  const safeHost = String(hostname || DEFAULT_HOST).replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(os.tmpdir(), `${RELAY_FILE_PREFIX}-${safeHost}.manager.json`)
}

function getRelayLogPath(hostname) {
  const safeHost = String(hostname || DEFAULT_HOST).replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(os.tmpdir(), `${RELAY_FILE_PREFIX}-${safeHost}.log`)
}

function getRelayLockPath(hostname) {
  const safeHost = String(hostname || DEFAULT_HOST).replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(os.tmpdir(), `${RELAY_FILE_PREFIX}-${safeHost}.lock`)
}

function parsePositiveInt(value, fallback, label) {
  const parsed = Number.parseInt(String(value || fallback), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${String(value)} (must be positive integer)`)
  }
  return parsed
}

function parseNonNegativeInt(value, fallback, label) {
  const parsed = Number.parseInt(String(value || fallback), 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${String(value)} (must be non-negative integer)`)
  }
  return parsed
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value || fallback), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port: ${String(value || fallback)} (must be 1-65535)`)
  }
  return parsed
}

function parsePortList(raw, fallback) {
  if (raw == null || raw === '') return fallback.slice()
  const tokens = String(raw).split(',')
  const parsedPorts = []
  for (const token of tokens) {
    const candidate = Number.parseInt(String(token).trim(), 10)
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) continue
    parsedPorts.push(candidate)
  }
  if (parsedPorts.length === 0) return fallback.slice()
  return [...new Set(parsedPorts)].sort((a, b) => a - b)
}

function parseArgs(argv) {
  const out = { help: false }
  if (!argv[0]) return out

  if (!argv[0].startsWith('--')) {
    out.command = argv[0]
    argv = argv.slice(1)
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--host' && argv[i + 1]) out.host = argv[++i]
    else if (arg === '--port' && argv[i + 1]) out.port = argv[++i]
    else if (arg === '--ports' && argv[i + 1]) out.ports = argv[++i]
    else if (arg === '--timeout' && argv[i + 1]) out.timeout = argv[++i]
    else if (arg === '--start-timeout-ms' && argv[i + 1]) out.startTimeoutMs = argv[++i]
    else if (arg === '--action' && argv[i + 1]) out.action = argv[++i]
    else if (arg === '--status-timeout-ms' && argv[i + 1]) out.statusTimeoutMs = argv[++i]
    else if (arg === '--auto-stop-ms' && argv[i + 1]) out.autoStopMs = argv[++i]
    else if (arg === '--all') out.all = true
  }

  return out
}

function printUsage() {
  console.log(`Usage:
  Relay manager uses in-code defaults (${DEFAULT_HOST}:${DEFAULT_PORT}).
  Override with --host / --port / --ports when needed.
  node scripts/relay-manager.js start [--host ${DEFAULT_HOST}] [--port ${DEFAULT_PORT}] [--ports ${DEFAULT_PORT},18794] [--timeout 12000] [--status-timeout-ms 1200] [--start-timeout-ms 10000] [--auto-stop-ms 7200000]
  node scripts/relay-manager.js status [--host ${DEFAULT_HOST}] [--port ${DEFAULT_PORT}] [--ports ${DEFAULT_PORT},18794] [--status-timeout-ms 1200] [--all]
  node scripts/relay-manager.js ports [--host ${DEFAULT_HOST}] --action add|remove --ports ${DEFAULT_PORT},18794 [--status-timeout-ms 1200]
  node scripts/relay-manager.js stop [--host ${DEFAULT_HOST}] [--port ${DEFAULT_PORT}] [--status-timeout-ms 1200]
`)
}
