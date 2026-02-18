#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18792
const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_START_TIMEOUT_MS = 10000
const DEFAULT_START_POLL_MS = 250
const REPO_ROOT = path.resolve(__dirname, '..')
const RELAY_FILE_PREFIX = 'grais-debugger-relay'

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

const host = args.host || DEFAULT_HOST
const port = parsePort(args.port, DEFAULT_PORT)
const timeoutMs = parsePositiveInt(args.timeout, DEFAULT_TIMEOUT_MS, '--timeout')
const startTimeoutMs = parsePositiveInt(args.startTimeoutMs, DEFAULT_START_TIMEOUT_MS, '--start-timeout-ms')

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

  throw new Error(`Unknown command "${command}"`)
}

async function startRelay() {
  const preCheck = await fetchRelayStatus(false)
  if (preCheck.ok) {
    console.log(`Relay already reachable at http://${host}:${port}/status`)
    return
  }

  const relayPid = launchRelayProcess()
  const started = await waitFor(
    () => fetchRelayStatus(false).then((status) => status.ok === true),
    startTimeoutMs,
    DEFAULT_START_POLL_MS,
  )
  if (!started) {
    throw new Error(`Relay did not become reachable at http://${host}:${port}/status within ${startTimeoutMs}ms`)
  }

  const lockOwner = readRelayLock()
  const state = {
    pid: Number.parseInt(String(lockOwner?.pid || relayPid || ''), 10) || null,
    host,
    port,
    startedAt: Date.now(),
  }
  fs.writeFileSync(relayStatePath, JSON.stringify(state, null, 2))

  const pidLabel = state.pid ? ` (server pid: ${state.pid})` : ''
  console.log(`Relay started in background at http://${host}:${port}/status${pidLabel}`)
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

  await waitFor(() => !fetchRelayStatus(false).then((s) => s.ok), 2000, 100)
  cleanupManagerState()
  console.log(`Relay stop requested for pid(s): ${uniquePids.join(', ')}`)
}

async function printStatus() {
  const status = await fetchRelayStatus(false)
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
    service: status.service,
    extensionConnected: status.extensionConnected,
    extensionLastSeenAgoMs: status.extensionLastSeenAgoMs,
    queuedControllerCommands: status.queuedControllerCommands,
    lockPid: lockOwner?.pid ?? null,
    managerPid: state?.pid ?? null,
  }
  console.log(JSON.stringify(payload, null, 2))
}

function launchRelayProcess() {
  const logPath = getRelayLogPath(host, port)
  const logHandle = fs.openSync(logPath, 'a')
  const child = spawn(
    process.execPath,
    [relayServerPath, '--host', host, '--port', String(port), '--timeout', String(timeoutMs)],
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

async function fetchRelayStatus(throwOnError = true) {
  try {
    const response = await requestJson(`http://${host}:${port}/status`)
    return {
      ok: true,
      ...(typeof response === 'object' && response ? response : {}),
    }
  } catch (error) {
    if (throwOnError) throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function requestJson(url, timeoutMs = 1000) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        protocol: 'http:',
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
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

function getRelayStatePath(hostname, relayPort) {
  const safeHost = String(hostname || DEFAULT_HOST).replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(os.tmpdir(), `${RELAY_FILE_PREFIX}-${safeHost}-${relayPort}.manager.json`)
}

function getRelayLogPath(hostname, relayPort) {
  const safeHost = String(hostname || DEFAULT_HOST).replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(os.tmpdir(), `${RELAY_FILE_PREFIX}-${safeHost}-${relayPort}.log`)
}

function getRelayLockPath(hostname, relayPort) {
  const safeHost = String(hostname || DEFAULT_HOST).replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(os.tmpdir(), `${RELAY_FILE_PREFIX}-${safeHost}-${relayPort}.lock`)
}

function parsePositiveInt(value, fallback, label) {
  const parsed = Number.parseInt(String(value || fallback), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${String(value)} (must be positive integer)`)
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
    else if (arg === '--timeout' && argv[i + 1]) out.timeout = argv[++i]
    else if (arg === '--start-timeout-ms' && argv[i + 1]) out.startTimeoutMs = argv[++i]
  }

  return out
}

function printUsage() {
  console.log(`Usage:
  node scripts/relay-manager.js start [--host 127.0.0.1] [--port 18792] [--timeout 12000] [--start-timeout-ms 10000]
  node scripts/relay-manager.js status [--host 127.0.0.1] [--port 18792]
  node scripts/relay-manager.js stop [--host 127.0.0.1] [--port 18792]
`)
}
