#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')

const SERVICE_NAME = 'grais-debugger-relay'
const SERVICE_LABEL = 'com.grais.debugger.relay'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18793
const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_MAX_RUNTIME_MS = 0
const DEFAULT_STATUS_TIMEOUT_MS = 1200
const DEFAULT_READY_TIMEOUT_MS = 5000
const DEFAULT_READY_CHECK_DELAY_MS = 250

const REPO_ROOT = path.resolve(fs.realpathSync(__dirname), '..')
const RELAY_SERVER_PATH = path.join(REPO_ROOT, 'relay-server.js')
const RELAY_HOST_DEFAULT = parseHost(process.env.GRAIS_RELAY_HOST || DEFAULT_HOST)
const RELAY_PORT_DEFAULT = parsePositiveInt(process.env.GRAIS_RELAY_PORT || String(DEFAULT_PORT), DEFAULT_PORT, 'relay port')

const args = parseArgs(process.argv.slice(2))
const command = args.command

if (args.help || !command) {
  printUsage()
  process.exit(0)
}

const host = parseHost(args.host || RELAY_HOST_DEFAULT)
const ports = parsePortList(args.ports || args.port || String(RELAY_PORT_DEFAULT), [RELAY_PORT_DEFAULT])
const timeoutMs = parsePositiveInt(args.timeout, DEFAULT_TIMEOUT_MS, 'timeout')
const maxRuntimeMs = parseNonNegativeInt(args.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS, 'max-runtime-ms')
const statusTimeoutMs = parsePositiveInt(args.statusTimeoutMs, DEFAULT_STATUS_TIMEOUT_MS, 'status-timeout-ms')
const readyTimeoutMs = parseNonNegativeInt(args.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS, 'ready-timeout-ms')
const waitForReady = args.waitForReady !== false

const PLATFORM = process.platform
const HOME_DIR = os.homedir()
const USER_SERVICE_DIR = getUserServiceDir()
const SERVICE_FILE = getServiceFilePath(PLATFORM)
const SERVICE_UNIT = getServiceUnitName()
const DOMAIN_TARGET = `gui/${process.getuid()}`

;(async () => {
  try {
    await run(command)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()

async function run(commandName) {
  if (commandName === 'install') {
    installService()
    if (waitForReady && readyTimeoutMs > 0) {
      try {
        await awaitServiceReady()
        console.log(`Relay service is reachable at http://${host}:${ports[0] || RELAY_PORT_DEFAULT}/status`)
      } catch (error) {
        console.warn(
          `Relay service installed but not reachable yet: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return
  }
  if (commandName === 'uninstall') {
    uninstallService()
    return
  }
  if (commandName === 'start') {
    startService()
    return
  }
  if (commandName === 'stop') {
    stopService()
    return
  }
  if (commandName === 'restart' || commandName === 'update') {
    if (serviceFileExists()) {
      stopService()
    }
    installService({ startOnly: false })
    if (waitForReady && readyTimeoutMs > 0) {
      await awaitServiceReady()
    }
    return
  }
  if (commandName === 'status') {
    await printStatus()
    return
  }

  throw new Error(`Unknown command "${commandName}"`)
}

function installService({ startOnly = true } = {}) {
  ensureServiceFile()

  if (PLATFORM === 'darwin') {
    runCmd('launchctl', ['bootout', `${DOMAIN_TARGET}/${SERVICE_LABEL}`], { ignoreError: true })
    runCmd('launchctl', ['disable', `${DOMAIN_TARGET}/${SERVICE_LABEL}`], { ignoreError: true })
    const bootstrapResult = runCmd('launchctl', ['bootstrap', DOMAIN_TARGET, SERVICE_FILE], {
      ignoreError: true,
      label: `bootstrap ${SERVICE_FILE}`,
    })
    if (!bootstrapResult.ok) {
      const loadResult = runCmd('launchctl', ['load', '-w', SERVICE_FILE], { ignoreError: true })
      if (!loadResult.ok) {
        throw new Error(
          `Failed to install launchd service using bootstrap/load: ${bootstrapResult.error || loadResult.error}`,
        )
      }
    }
    if (!isServiceRunning()) {
      const startResult = runCmd('launchctl', ['start', SERVICE_LABEL], { ignoreError: true })
      if (!startResult.ok) {
        throw new Error(`Failed to start ${SERVICE_LABEL}: ${startResult.error || startResult.stderr || startResult.stdout}`)
      }
    }
  } else if (PLATFORM === 'linux') {
    runCmd('systemctl', ['--user', 'daemon-reload'])
    runCmd('systemctl', ['--user', 'enable', `${SERVICE_UNIT}`])
    const isActive = isServiceRunning()
    if (!isActive) {
      runCmd('systemctl', ['--user', 'start', `${SERVICE_UNIT}`])
    }
  } else {
    throw new Error(`Unsupported platform ${PLATFORM}`)
  }

  if (startOnly) {
    console.log(`Relay service installed and started: ${SERVICE_FILE || SERVICE_UNIT}`)
  }
}

function uninstallService() {
  if (!serviceFileExists()) {
    console.log('Service is not installed for this user profile.')
    return
  }

  if (PLATFORM === 'darwin') {
    runCmd('launchctl', ['unload', '-w', SERVICE_FILE], { ignoreError: true })
    runCmd('launchctl', ['bootout', `${DOMAIN_TARGET}/${SERVICE_LABEL}`], { ignoreError: true })
  } else if (PLATFORM === 'linux') {
    runCmd('systemctl', ['--user', 'stop', `${SERVICE_UNIT}`], { ignoreError: true })
    runCmd('systemctl', ['--user', 'disable', `${SERVICE_UNIT}`], { ignoreError: true })
    runCmd('systemctl', ['--user', 'daemon-reload'])
  } else {
    throw new Error(`Unsupported platform ${PLATFORM}`)
  }

  fs.unlinkSync(SERVICE_FILE)
  console.log(`Removed ${PLATFORM === 'linux' ? SERVICE_UNIT : SERVICE_FILE}`)
}

function startService() {
  if (!serviceFileExists()) {
    throw new Error('Service not installed. Run `node scripts/relay-service.js install` first.')
  }
  if (PLATFORM === 'darwin') {
    if (isServiceRunning()) {
      console.log(`Service already running: ${SERVICE_LABEL}`)
      return
    }
    runCmd('launchctl', ['start', SERVICE_LABEL])
  } else if (PLATFORM === 'linux') {
    runCmd('systemctl', ['--user', 'start', `${SERVICE_UNIT}`])
  } else {
    throw new Error(`Unsupported platform ${PLATFORM}`)
  }
  console.log(`Started ${PLATFORM === 'linux' ? SERVICE_NAME : SERVICE_LABEL}`)
}

function stopService() {
  if (!serviceFileExists()) {
    throw new Error('Service not installed. Run `node scripts/relay-service.js install` first.')
  }
  if (PLATFORM === 'darwin') {
    runCmd('launchctl', ['bootout', `${DOMAIN_TARGET}/${SERVICE_LABEL}`], { ignoreError: true })
    runCmd('launchctl', ['stop', SERVICE_LABEL], { ignoreError: true })
    runCmd('launchctl', ['unload', '-w', SERVICE_FILE], { ignoreError: true })
  } else if (PLATFORM === 'linux') {
    runCmd('systemctl', ['--user', 'stop', `${SERVICE_UNIT}`])
  } else {
    throw new Error(`Unsupported platform ${PLATFORM}`)
  }
  console.log(`Stopped ${PLATFORM === 'linux' ? SERVICE_NAME : SERVICE_LABEL}`)
}

async function printStatus() {
  const relayStatus = await getRelayStatus()
  const running = isServiceRunning()

  const payload = {
    ok: true,
    service: PLATFORM === 'linux' ? SERVICE_NAME : SERVICE_LABEL,
    host,
    ports,
    serviceInstalled: serviceFileExists(),
    serviceRunning: running,
    relayReachable: relayStatus.ok,
    relayStatus: relayStatus.ok ? relayStatus.payload : null,
  }

  console.log(JSON.stringify(payload, null, 2))
}

async function awaitServiceReady() {
  const deadline = Date.now() + readyTimeoutMs
  let lastError = `timed out after ${readyTimeoutMs}ms`
  const checkDelay = Math.max(DEFAULT_READY_CHECK_DELAY_MS, 50)
  while (Date.now() < deadline) {
    const result = await getRelayStatus()
    if (result.ok) return result

    lastError = result.error || 'unknown'

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      break
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(checkDelay, remaining)))
  }

  throw new Error(`HTTP readiness check failed: ${lastError}`)
}

function getRelayStatus() {
  return getRelayStatusByPorts()
}

function getRelayStatusByPorts(portsToCheck = ports) {
  const targets = Array.isArray(portsToCheck) && portsToCheck.length > 0 ? [...new Set(portsToCheck)] : []
  if (targets.length === 0) {
    return Promise.resolve({ ok: false, error: 'No relay port configured' })
  }

  return (async () => {
    let lastError = 'No relay port configured'
    for (const targetPort of targets) {
      const status = await getRelayStatusByPort(targetPort)
      if (status.ok) {
        return { ...status, port: targetPort }
      }
      lastError = status.error || 'unknown'
    }
    return { ok: false, error: lastError }
  })()
}

function getRelayStatusByPort(targetPort) {
  const parsedPort = Number.parseInt(String(targetPort), 10)
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return Promise.resolve({ ok: false, error: `Invalid port: ${String(targetPort)}` })
  }

  return new Promise((resolve) => {
    const requestUrl = new URL(`http://${host}:${parsedPort}/status`)
    const request = http.request(
      {
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: requestUrl.pathname,
        method: 'GET',
        timeout: statusTimeoutMs,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => {
          chunks.push(String(chunk || ''))
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            resolve({ ok: false, error: `HTTP ${response.statusCode}` })
            return
          }
          const body = chunks.join('')
          try {
            resolve({ ok: true, payload: JSON.parse(body || '{}') })
          } catch {
            resolve({ ok: false, error: 'Invalid JSON from relay' })
          }
        })
      },
    )

    request.on('error', (error) => {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    request.on('timeout', () => {
      request.destroy(new Error('HTTP timeout'))
    })
    request.end()
  })
}

function isServiceRunning() {
  if (PLATFORM === 'darwin') {
    const result = runCmd('launchctl', ['print', `${DOMAIN_TARGET}/${SERVICE_LABEL}`], { ignoreError: true })
    return result.ok
  }

  if (PLATFORM === 'linux') {
    const result = runCmd('systemctl', ['--user', 'is-active', `${SERVICE_UNIT}`], { ignoreError: true })
    return result.ok
  }

  return false
}

function ensureServiceFile() {
  ensureDirectory(path.dirname(SERVICE_FILE))
  ensureDirectory(USER_SERVICE_DIR)

  if (PLATFORM === 'darwin') {
    const launchConfig = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${RELAY_SERVER_PATH}</string>
    <string>--host</string>
    <string>${host}</string>
    <string>--ports</string>
    <string>${ports.join(',')}</string>
    <string>--timeout</string>
    <string>${timeoutMs}</string>
    <string>--max-runtime-ms</string>
    <string>${maxRuntimeMs}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(USER_SERVICE_DIR, 'relay-service.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(USER_SERVICE_DIR, 'relay-service.log')}</string>
</dict>
</plist>
`

    fs.writeFileSync(SERVICE_FILE, launchConfig, 'utf8')
    return
  }

  if (PLATFORM === 'linux') {
    const unit = `[Unit]
Description=Grais Debugger Relay
After=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${RELAY_SERVER_PATH} --host ${host} --ports ${ports.join(',')} --timeout ${timeoutMs} --max-runtime-ms ${maxRuntimeMs}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
    fs.writeFileSync(SERVICE_FILE, unit, 'utf8')
    return
  }

  throw new Error(`Unsupported platform ${PLATFORM}`)
}

function serviceFileExists() {
  return fs.existsSync(SERVICE_FILE)
}

function ensureDirectory(directory) {
  if (PLATFORM === 'darwin' || PLATFORM === 'linux') {
    fs.mkdirSync(directory, { recursive: true })
    return
  }
  throw new Error(`Unsupported platform ${PLATFORM}`)
}

function getServiceFilePath(platform) {
  if (platform === 'darwin') {
    return path.join(HOME_DIR, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
  }
  if (platform === 'linux') {
    return path.join(HOME_DIR, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`)
  }
  return ''
}

function getServiceUnitName() {
  return `${SERVICE_NAME}.service`
}

function getUserServiceDir() {
  if (PLATFORM === 'darwin') {
    return path.join(HOME_DIR, 'Library', 'Logs', SERVICE_NAME)
  }
  return path.join(HOME_DIR, '.local', 'share', SERVICE_NAME)
}

function runCmd(commandName, commandArgs, options = {}) {
  const { ignoreError = false, label = `${commandName} ${commandArgs.join(' ')}` } = options
  try {
    const response = spawnSync(commandName, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })

    if (response.status === 0) {
      return {
        ok: true,
        stdout: String(response.stdout || ''),
        stderr: String(response.stderr || ''),
      }
    }

    if (ignoreError) {
      return {
        ok: false,
        error: `exit ${response.status}`,
        stdout: String(response.stdout || ''),
        stderr: String(response.stderr || ''),
      }
    }

    const statusLabel = Number.isInteger(response.status)
      ? String(response.status)
      : response.signal
        ? `signal ${response.signal}`
        : 'unknown status'
    const detail = String(response.stderr || response.stdout || '').trim()
    throw new Error(`${label} failed (${statusLabel}): ${detail}`)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Required command missing: ${commandName}`)
    }
    if (ignoreError) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    throw error
  }
}

function parseArgs(argv) {
  const out = { command: null, help: false }
  if (!argv[0]) return out

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }

    if (!arg.startsWith('--')) {
      if (!out.command) {
        out.command = arg
      }
      continue
    }

    if (arg === '--host' && argv[i + 1]) out.host = argv[++i]
    else if (arg === '--ports' && argv[i + 1]) out.ports = argv[++i]
    else if (arg === '--port' && argv[i + 1]) out.port = argv[++i]
    else if (arg === '--timeout' && argv[i + 1]) out.timeout = argv[++i]
    else if (arg === '--max-runtime-ms' && argv[i + 1]) out.maxRuntimeMs = argv[++i]
    else if (arg === '--status-timeout-ms' && argv[i + 1]) out.statusTimeoutMs = argv[++i]
    else if (arg === '--ready-timeout-ms' && argv[i + 1]) out.readyTimeoutMs = argv[++i]
    else if (arg === '--wait-for-ready' || arg === '--wait') out.waitForReady = true
    else if (arg === '--no-wait-for-ready' || arg === '--no-wait') out.waitForReady = false
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

function parseNonNegativeInt(value, fallback, label) {
  const parsed = Number.parseInt(String(value || fallback), 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${String(value)} (must be non-negative integer)`)
  }
  return parsed
}

function parsePortList(raw, fallback) {
  if (raw == null || raw === '') return fallback.slice()
  const tokens = String(raw).split(',')
  const ports = []
  for (const token of tokens) {
    const candidate = Number.parseInt(String(token).trim(), 10)
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
      continue
    }
    ports.push(candidate)
  }
  return ports.length > 0 ? [...new Set(ports)].sort((a, b) => a - b) : fallback.slice()
}

function parseHost(value) {
  const candidate = String(value || '').trim() || DEFAULT_HOST
  return candidate
}

function printUsage() {
  const usage = `Usage:
  node scripts/relay-service.js install [--host ${DEFAULT_HOST}] [--ports ${DEFAULT_PORT},18794] [--timeout 12000] [--max-runtime-ms 0] [--ready-timeout-ms 5000] [--wait-for-ready]
  node scripts/relay-service.js status [--host ${DEFAULT_HOST}] [--ports ${DEFAULT_PORT},18794] [--status-timeout-ms 1200]
  node scripts/relay-service.js start|stop|restart|update|uninstall
  node scripts/relay-service.js [--status-timeout-ms 1200] [--ready-timeout-ms 5000] [--wait-for-ready]

Commands:
  install     Write service file + enable/start the relay service (macOS launchd, Linux systemd --user)
  uninstall   Remove service file and stop service
  start       Start installed service
  stop        Stop installed service
  restart     Stop then install/start service config
  update      Alias for restart
  status      Print service + relay status
`
  console.log(usage)
}
