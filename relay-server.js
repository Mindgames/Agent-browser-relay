#!/usr/bin/env node
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebSocketServer } = require('ws')

const DEFAULT_PORT = 18792
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_MAX_RUNTIME_MS = 0
const QUEUED_REQUEST_TIMEOUT_MS = 12000
const RELAY_HEARTBEAT_TIMEOUT_MS = 15000
const RELAY_HEARTBEAT_INTERVAL_MS = 2500
const MAX_QUEUED_CONTROLLER_COMMANDS = 16

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(`Usage:
  node relay-server.js [--host 127.0.0.1] [--port 18792] [--timeout 12000] [--max-runtime-ms 0]

Options:
  --host            Bind address (default: ${DEFAULT_HOST})
  --port            Listen port (default: ${DEFAULT_PORT})
  --timeout         Controller request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --max-runtime-ms  Auto-stop relay after N ms (default: disabled)
`)
  process.exit(0)
}

const host = args.host || DEFAULT_HOST
const port = clampPort(args.port, DEFAULT_PORT)
const requestTimeoutMs = parsePositiveInt(args.timeout, DEFAULT_TIMEOUT_MS, 'timeout')
const maxRuntimeMs = parseNonNegativeInt(args.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS, 'max-runtime-ms')
const relayLockPath = getRelayLockPath(host, port)
const relayLockFd = acquireRelayLock(relayLockPath)
let autoShutdownTimer = null
let shuttingDown = false

/** @type {import('node:net').Socket | null} */
let extensionSocket = null
/** @type {Set<any>} */
const controllerSockets = new Set()
/** @type {Map<number, {tabId:number, targetId:string|null, title:string|null, url:string|null, attachedAtMs:number, lastSeenAtMs:number}>} */
const attachedTabsById = new Map()
/** @type {Map<number, {socket: any, requestId: number, timer: NodeJS.Timeout}>} */
const pendingByRelayId = new Map()
/** @type {Array<{relayId: number, socket: any, requestId: number, payload: any, timer: NodeJS.Timeout}>} */
const queuedControllerRequests = []
let nextRelayId = 1
let extensionLastSeenTs = 0
let relayHeartbeatWatchdog = null

const socketMeta = new WeakMap()

const httpServer = http.createServer((request, response) => {
  const method = request.method || 'GET'
  const pathname = request.url?.split('?')[0] || '/'

  if (pathname === '/status') {
      if (method === 'GET' || method === 'HEAD') {
      const extensionConnected = Boolean(extensionSocket && extensionSocket.readyState === extensionSocket.OPEN)
      const extensionLastSeenAgoMs = extensionLastSeenTs ? Date.now() - extensionLastSeenTs : null
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end(
        method === 'HEAD'
          ? ''
          : JSON.stringify({
              ok: true,
              service: 'grais-debugger-relay',
              host,
              port,
              extensionConnected,
              extensionLastSeenAgoMs,
              attachedTabs: getAttachedTabsSnapshot(),
              queuedControllerCommands: queuedControllerRequests.length,
              connectedControllerClients: controllerSockets.size,
              pendingCommands: pendingByRelayId.size,
            }),
      )
      return
    }

    response.statusCode = 405
    response.setHeader('allow', 'GET,HEAD')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
    return
  }

  if (pathname !== '/' && pathname !== '') {
    response.statusCode = 404
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: false, error: 'not_found' }))
    return
  }

  if (method === 'GET' || method === 'HEAD') {
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(method === 'HEAD' ? '' : JSON.stringify({ ok: true, service: 'grais-debugger-relay' }))
    return
  }

  response.statusCode = 405
  response.setHeader('allow', 'GET,HEAD')
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
})

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (socket) => {
  const state = {
    role: 'unknown',
    socket,
    seenAtMs: Date.now(),
  }
  socketMeta.set(socket, state)
  controllerSockets.add(socket)

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }

    if (state.role === 'unknown') {
      if (isControllerMessage(msg)) {
        state.role = 'controller'
      } else if (isExtensionMessage(msg)) {
        state.role = 'extension'
      } else if (msg && msg.method === 'ping') {
        // Allow controllers to send ping keepalives before any request is seen.
        state.role = 'controller'
      } else {
        return
      }

      if (state.role === 'extension') {
        state.seenAtMs = Date.now()
        extensionLastSeenTs = state.seenAtMs
        attachedTabsById.clear()
        if (extensionSocket && extensionSocket !== socket && extensionSocket.readyState === extensionSocket.OPEN) {
          extensionSocket.close(1008, 'new_extension_client')
        }
        extensionSocket = socket
        startRelayHeartbeatWatchdog()
        notifyControllers({ method: 'relayEvent', params: { type: 'extension_connected' } })
        flushQueuedControllerCommands()
      }
    }

    if (state.role === 'extension') {
      return onExtensionMessage(msg, socket)
    }

    return onControllerMessage(msg, socket)
  })

  socket.on('close', () => {
    const wasExtensionSocket = extensionSocket === socket

    if (extensionSocket === socket) {
      extensionSocket = null
      extensionLastSeenTs = 0
      attachedTabsById.clear()
      stopRelayHeartbeatWatchdog()
      notifyControllers({ method: 'relayEvent', params: { type: 'extension_disconnected' } })
    }

    failPending(wasExtensionSocket ? null : socket, 'Relay disconnected')

    controllerSockets.delete(socket)
    socketMeta.delete(socket)
  })

  socket.on('error', () => {
    // Keep sockets resilient. Individual handlers handle failures explicitly.
  })
})

httpServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname
  if (pathname !== '/extension') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

function onExtensionMessage(msg, socket) {
  const state = socketMeta.get(socket)
  if (state) {
    state.seenAtMs = Date.now()
    extensionLastSeenTs = state.seenAtMs
  }

  if (msg && msg.method === 'Grais.extensionHeartbeat') {
    return
  }

  if (msg && msg.method === 'Grais.extensionTabState') {
    handleExtensionTabState(msg.params)
    return
  }

  if (msg && typeof msg.id === 'number') {
    console.log('[Relay] extension response', { relayId: msg.id })
    // Reply to a previously proxied controller request.
    const pending = pendingByRelayId.get(msg.id)
    console.log('[Relay] extension response lookup', {
      relayId: msg.id,
      hasPending: Boolean(pending),
      requestId: pending?.requestId,
    })
    if (!pending) return

    const payload = {
      id: pending.requestId,
      ...(msg.result !== undefined ? { result: msg.result } : {}),
      ...(msg.error !== undefined ? { error: msg.error } : {}),
    }

    clearTimeout(pending.timer)
    pendingByRelayId.delete(msg.id)
    safeSend(pending.socket, payload)
    return
  }

  if (msg && msg.method === 'forwardCDPEvent') {
    notifyControllers(msg)
    return
  }

  if (msg && msg.method === 'pong') {
    return
  }
}

function onControllerMessage(msg, socket) {
  if (typeof msg?.id === 'number' && typeof msg?.method === 'string') {
    console.log('[Relay] controller request', {
      id: msg.id,
      method: msg.method,
      hasParams: Boolean(msg?.params),
    })
  }
  if (msg && msg.method === 'ping') {
    safeSend(socket, { method: 'pong' })
    return
  }

  const forward = toRelayPayload(msg)
  if (!forward) {
    return
  }

  if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
    queueControllerCommand(forward, socket)
    return
  }

  forwardControllerToExtension(forward, socket)
}

function getRelayLockPath(hostname, relayPort) {
  const safeHost = String(hostname || DEFAULT_HOST).replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(os.tmpdir(), `grais-debugger-relay-${safeHost}-${relayPort}.lock`)
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readRelayLockFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function acquireRelayLock(filePath) {
  let tries = 0
  while (tries < 2) {
    tries += 1
    try {
      const fd = fs.openSync(filePath, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), host, port }))
      return fd
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      const existing = readRelayLockFile(filePath)
      const pid = Number.parseInt(String(existing?.pid || ''), 10)
      if (Number.isInteger(pid) && isProcessAlive(pid)) {
        throw new Error(`Another relay process is already running on ${host}:${port} (pid ${pid})`)
      }

      try {
        fs.unlinkSync(filePath)
      } catch {
        // Keep trying with existing lock removed.
      }
    }
  }

  throw new Error(`Failed to acquire relay lock for ${host}:${port}`)
}

function releaseRelayLock() {
  try {
    if (relayLockFd !== null && relayLockFd !== undefined) {
      fs.closeSync(relayLockFd)
    }
  } catch {
    // best effort
  }

  try {
    const current = readRelayLockFile(relayLockPath)
    if (current?.pid === process.pid) {
      fs.unlinkSync(relayLockPath)
    }
  } catch {
    // best effort
  }
}

function queueControllerCommand(forward, socket) {
  while (queuedControllerRequests.length >= MAX_QUEUED_CONTROLLER_COMMANDS) {
    const overflow = queuedControllerRequests.shift()
    if (!overflow) break
    clearTimeout(overflow.timer)
    pendingByRelayId.delete(overflow.relayId)
    throwErrorToController(overflow.socket, overflow.requestId, 'Relay queue full; command dropped')
  }

  const relayId = nextRelayId
  nextRelayId += 1
  const payload = {
    id: relayId,
    method: forward.method,
    params: forward.params,
  }

  const queueEntry = {
    relayId,
    socket,
    requestId: forward.id,
    payload,
    timer: setTimeout(() => {
      dequeueControllerCommand(relayId, `Relay has no active extension connection for ${QUEUED_REQUEST_TIMEOUT_MS}ms`)
    }, QUEUED_REQUEST_TIMEOUT_MS),
  }

  queuedControllerRequests.push(queueEntry)
  pendingByRelayId.set(relayId, {
    socket,
    requestId: forward.id,
    timer: queueEntry.timer,
  })

  notifyControllers({
    method: 'relayEvent',
    params: {
      type: 'extension_offline_queue',
      queue: queuedControllerRequests.length,
      requestId: forward.id,
    },
  })
}

function dequeueControllerCommand(relayId, reason) {
  const index = queuedControllerRequests.findIndex((entry) => entry.relayId === relayId)
  if (index === -1) return
  const entry = queuedControllerRequests[index]
  queuedControllerRequests.splice(index, 1)
  clearTimeout(entry.timer)
  const pending = pendingByRelayId.get(relayId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingByRelayId.delete(relayId)
  }
  throwErrorToController(entry.socket, entry.requestId, reason)
}

function flushQueuedControllerCommands() {
  if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
    return
  }

  while (queuedControllerRequests.length > 0) {
    const entry = queuedControllerRequests.shift()
    if (!entry) return
    const pending = pendingByRelayId.get(entry.relayId)
    if (!pending) {
      clearTimeout(entry.timer)
      continue
    }

    clearTimeout(pending.timer)
    pendingByRelayId.set(entry.relayId, {
      ...pending,
      timer: setTimeout(() => {
        pendingByRelayId.delete(entry.relayId)
        throwErrorToController(entry.socket, entry.requestId, `Relay timed out after ${requestTimeoutMs}ms`)
      }, requestTimeoutMs),
    })
    const replayPending = pendingByRelayId.get(entry.relayId)
    if (!replayPending) {
      clearTimeout(entry.timer)
      continue
    }

    try {
      sendToExtension(entry.payload)
    } catch (error) {
      clearTimeout(replayPending.timer)
      clearTimeout(entry.timer)
      pendingByRelayId.delete(entry.relayId)
      throwErrorToController(
        entry.socket,
        entry.requestId,
        `Failed to dispatch queued command: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function forwardControllerToExtension(forward, socket) {
  const relayId = nextRelayId
  nextRelayId += 1
  console.log('[Relay] forwarding to extension', {
    relayId,
    requestId: forward.id,
    method: forward.method,
  })
  const payload = {
    id: relayId,
    method: forward.method,
    params: forward.params,
  }

  pendingByRelayId.set(relayId, {
    socket,
    requestId: forward.id,
    timer: setTimeout(() => {
      pendingByRelayId.delete(relayId)
      throwErrorToController(socket, forward.id, `Relay timed out after ${requestTimeoutMs}ms`)
    }, requestTimeoutMs),
  })

  const pending = pendingByRelayId.get(relayId)
  if (!pending) return
  try {
    sendToExtension(payload)
  } catch (error) {
    clearTimeout(pending.timer)
    pendingByRelayId.delete(relayId)
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      queueControllerCommand(forward, socket)
      return
    }
    throwErrorToController(
      socket,
      forward.id,
      `Failed to dispatch command: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function sendToExtension(payload) {
  if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
    throw new Error('Relay has no active extension connection')
  }
  console.log('[Relay] sendToExtension', {
    id: payload?.id,
    method: payload?.method,
    hasParams: Boolean(payload?.params),
  })
  extensionSocket.send(JSON.stringify(payload))
}

function handleExtensionTabState(params) {
  if (!params || typeof params !== 'object') return

  const event = String(params.event || '').toLowerCase()
  const rawTabId = Number.parseInt(String(params.tabId || ''), 10)
  if (!Number.isInteger(rawTabId)) return

  if (event === 'detached' || event === 'removed' || event === 'cleared') {
    attachedTabsById.delete(rawTabId)
    return
  }

  if (event !== 'attached') return

  const tabId = rawTabId
  const targetId = typeof params.targetId === 'string' && params.targetId.trim() ? params.targetId.trim() : null
  const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : null
  const rawUrl = typeof params.url === 'string' && params.url.trim() ? params.url.trim() : null
  const current = attachedTabsById.get(tabId)
  const now = Date.now()

  attachedTabsById.set(tabId, {
    tabId,
    targetId,
    title,
    url: rawUrl,
    attachedAtMs: current?.attachedAtMs || now,
    lastSeenAtMs: now,
  })
}

function getAttachedTabsSnapshot() {
  const snapshot = [...attachedTabsById.values()].map((entry) => ({
    tabId: entry.tabId,
    targetId: entry.targetId,
    title: entry.title,
    url: entry.url,
    attachedAtMs: entry.attachedAtMs,
    lastSeenAtMs: entry.lastSeenAtMs,
  }))

  snapshot.sort((a, b) => a.tabId - b.tabId)
  return snapshot
}

function failPending(socket, reason) {
  for (const [relayId, pending] of pendingByRelayId) {
    if (!socket || pending.socket === socket) {
      clearTimeout(pending.timer)
      pendingByRelayId.delete(relayId)
      throwErrorToController(pending.socket, pending.requestId, reason)
    }
  }
}

function toRelayPayload(msg) {
  if (typeof msg !== 'object' || msg === null) return null
  if (typeof msg.id !== 'number') return null
  if (typeof msg.method !== 'string') return null

  const { id, method, params } = msg
  if (!method) return null

  return {
    id,
    method,
    params,
  }
}

function isControllerMessage(msg) {
  if (typeof msg !== 'object' || msg === null) return false
  if (msg && typeof msg.id === 'number' && typeof msg.method === 'string') return true
  return false
}

function isExtensionMessage(msg) {
  if (typeof msg !== 'object' || msg === null) return false
  if (msg && msg.method === 'forwardCDPEvent') return true
  if (msg && msg.method === 'Grais.extensionHeartbeat') return true
  if (msg && msg.method === 'Grais.extensionTabState') return true
  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) return true
  return false
}

function notifyControllers(message) {
  for (const controller of controllerSockets) {
    if (controller !== extensionSocket) {
      safeSend(controller, message)
    }
  }
}

function throwErrorToController(socket, id, error) {
  if (typeof id !== 'number') return
  safeSend(socket, { id, error })
}

function safeSend(socket, payload) {
  if (!socket || socket.readyState !== socket.OPEN) return
  try {
    socket.send(JSON.stringify(payload))
  } catch {
    // Best effort.
  }
}

function startRelayHeartbeatWatchdog() {
  if (relayHeartbeatWatchdog) {
    return
  }

  relayHeartbeatWatchdog = setInterval(() => {
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) return
    if (!extensionLastSeenTs) return

    const elapsed = Date.now() - extensionLastSeenTs
    if (elapsed > RELAY_HEARTBEAT_TIMEOUT_MS) {
      extensionSocket.close(1001, 'heartbeat timeout')
    }
  }, RELAY_HEARTBEAT_INTERVAL_MS)
}

function stopRelayHeartbeatWatchdog() {
  if (!relayHeartbeatWatchdog) return
  clearInterval(relayHeartbeatWatchdog)
  relayHeartbeatWatchdog = null
}

function stopAutoShutdownTimer() {
  if (!autoShutdownTimer) return
  clearTimeout(autoShutdownTimer)
  autoShutdownTimer = null
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  stopAutoShutdownTimer()
  releaseRelayLock()
  stopRelayHeartbeatWatchdog()
  wss.clients.forEach((socket) => socket.close())
  httpServer.close(() => process.exit(exitCode))
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

function clampPort(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return fallback
  return parsed
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--port' && argv[i + 1]) {
      out.port = argv[++i]
    } else if (arg === '--host' && argv[i + 1]) {
      out.host = argv[++i]
    } else if (arg === '--timeout' && argv[i + 1]) {
      out.timeout = argv[++i]
    } else if (arg === '--max-runtime-ms' && argv[i + 1]) {
      out.maxRuntimeMs = argv[++i]
    }
  }
  return out
}

httpServer.listen(port, host, () => {
  console.log(`Grais Debugger relay listening on ws://${host}:${port}/extension`)
  console.log(`Health endpoint: http://${host}:${port}/`)
  if (maxRuntimeMs > 0) {
    autoShutdownTimer = setTimeout(() => {
      console.log(`Auto-stopping relay after max runtime (${maxRuntimeMs}ms)`)
      shutdown(0)
    }, maxRuntimeMs)
  }
})

process.on('SIGINT', () => {
  shutdown(0)
})

process.on('SIGTERM', () => {
  shutdown(0)
})

process.on('exit', () => {
  releaseRelayLock()
})
