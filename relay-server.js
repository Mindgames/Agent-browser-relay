#!/usr/bin/env node
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebSocketServer } = require('ws')

const DEFAULT_PORT = 18793
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_MAX_RUNTIME_MS = 0
const QUEUED_REQUEST_TIMEOUT_MS = 12000
const RELAY_HEARTBEAT_TIMEOUT_MS = 15000
const RELAY_HEARTBEAT_INTERVAL_MS = 2500
const MAX_QUEUED_CONTROLLER_COMMANDS = 16
const ALLOWED_ADMIN_ACTIONS = ['add', 'remove']
const SESSION_ID_PREFIX = 'relay-session'

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(`Usage:
  node relay-server.js [--host 127.0.0.1] [--ports 18793[,18794]]
  node relay-server.js [--host 127.0.0.1] [--port 18793]
  node relay-server.js [--host 127.0.0.1] [--port 18793] [--timeout 12000] [--max-runtime-ms 0]

Options:
  --host            Bind address (default: ${DEFAULT_HOST})
  --port            Compatibility alias for a single-port relay
  --ports           Comma-separated list of physical relay ports (default: ${DEFAULT_PORT})
  --timeout         Controller request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --max-runtime-ms  Auto-stop relay after N ms (default: disabled)
`)
  process.exit(0)
}

const host = args.host || DEFAULT_HOST
const relayPorts = parsePortList(args.ports || args.port, [DEFAULT_PORT])
if (relayPorts.length === 0) {
  throw new Error(`No valid ports provided from input: ${String(args.ports || args.port || DEFAULT_PORT)}`)
}

const requestTimeoutMs = parsePositiveInt(args.timeout, DEFAULT_TIMEOUT_MS, 'timeout')
const maxRuntimeMs = parseNonNegativeInt(args.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS, 'max-runtime-ms')
const relayLockPath = getRelayLockPath(host)
const relayLockFd = acquireRelayLock(relayLockPath)
let autoShutdownTimer = null
let shuttingDown = false

/** @type {Map<number, PortState>} */
const portStates = new Map()

const socketMeta = new WeakMap()

initializePorts(relayPorts).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

function initializePorts(ports) {
  return new Promise((resolve, reject) => {
    const sortedPorts = [...new Set(ports)].sort((a, b) => a - b)
    const listeners = sortedPorts.map((port) => startPortListener(port))
    Promise.all(listeners)
      .then(() => {
        const portsLabel = sortedPorts.join(', ')
        if (sortedPorts.length > 1) {
          console.log(`Agent Browser Relay listening on ports: ${portsLabel} (shared relay hub)`)
        } else {
          console.log(`Agent Browser Relay listening on ws://${host}:${sortedPorts[0]}/extension`)
        }
        console.log(`Health endpoint: http://${host}:${sortedPorts[0]}/`)
        if (maxRuntimeMs > 0) {
          autoShutdownTimer = setTimeout(() => {
            console.log(`Auto-stopping relay after max runtime (${maxRuntimeMs}ms)`)
            shutdown(0)
          }, maxRuntimeMs)
        }
        resolve()
      })
      .catch((error) => {
        shutdown(1, `Failed to start port ${portsLabel}: ${error instanceof Error ? error.message : String(error)}`)
        reject(error)
      })
  })
}

function createPortState(relayPort) {
  return {
    relayPort,
    extensionSocket: null,
    controllerSockets: new Set(),
    pendingByRelayId: new Map(),
    queuedControllerRequests: [],
    nextRelayId: 1,
    extensionLastSeenTs: 0,
    extensionHeartbeatState: null,
    extensionSessionToTab: new Map(),
    sessionsById: new Map(),
    tabLeases: new Map(),
    nextSessionId: 1,
    relayHeartbeatWatchdog: null,
    httpServer: null,
    wss: null,
  }
}

function getPortState(relayPort) {
  return portStates.get(relayPort) || null
}

function countConnectedControllerClients(state) {
  let count = 0
  for (const socket of state.controllerSockets) {
    if (!socket || socket === state.extensionSocket) continue
    if (socket.readyState !== socket.OPEN) continue
    count += 1
  }
  return count
}

function summarizePortState(state) {
  const extensionConnected = Boolean(state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN)
  const extensionLastSeenAgoMs = state.extensionLastSeenTs ? Date.now() - state.extensionLastSeenTs : null

  return {
    port: state.relayPort,
    extensionConnected,
    extensionLastSeenAgoMs,
    queuedControllerCommands: state.queuedControllerRequests.length,
    connectedControllerClients: countConnectedControllerClients(state),
    pendingCommands: state.pendingByRelayId.size,
    sessionCount: state.sessionsById.size,
    leasedTabCount: state.tabLeases.size,
    activeTab: state.extensionHeartbeatState?.activeTab || null,
    attachedTabs: Array.isArray(state.extensionHeartbeatState?.attachedTabs)
      ? state.extensionHeartbeatState.attachedTabs
      : [],
    tabLeases: summarizeTabLeases(state),
    lastHeartbeatTs: state.extensionHeartbeatState?.ts || null,
    extensionVersion: state.extensionHeartbeatState?.extensionVersion || null,
    extensionName: state.extensionHeartbeatState?.extensionName || null,
    extensionCapabilities:
      state.extensionHeartbeatState?.extensionCapabilities && typeof state.extensionHeartbeatState.extensionCapabilities === 'object'
        ? state.extensionHeartbeatState.extensionCapabilities
        : null,
    allowTargetCreate:
      typeof state.extensionHeartbeatState?.allowTargetCreate === 'boolean'
        ? state.extensionHeartbeatState.allowTargetCreate
        : null,
  }
}

function getSinglePortStatus(state) {
  return {
    ok: true,
    service: 'grais-debugger-relay',
    host,
    port: state.relayPort,
    extensionConnected: Boolean(state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN),
    extensionLastSeenAgoMs: state.extensionLastSeenTs ? Date.now() - state.extensionLastSeenTs : null,
    queuedControllerCommands: state.queuedControllerRequests.length,
    connectedControllerClients: countConnectedControllerClients(state),
    pendingCommands: state.pendingByRelayId.size,
    sessionCount: state.sessionsById.size,
    leasedTabCount: state.tabLeases.size,
    activeTab: state.extensionHeartbeatState?.activeTab || null,
    attachedTabs: Array.isArray(state.extensionHeartbeatState?.attachedTabs)
      ? state.extensionHeartbeatState.attachedTabs
      : [],
    tabLeases: summarizeTabLeases(state),
    extensionVersion: state.extensionHeartbeatState?.extensionVersion || null,
    extensionName: state.extensionHeartbeatState?.extensionName || null,
    extensionCapabilities:
      state.extensionHeartbeatState?.extensionCapabilities && typeof state.extensionHeartbeatState.extensionCapabilities === 'object'
        ? state.extensionHeartbeatState.extensionCapabilities
        : null,
    allowTargetCreate:
      typeof state.extensionHeartbeatState?.allowTargetCreate === 'boolean'
        ? state.extensionHeartbeatState.allowTargetCreate
        : null,
  }
}

function summarizeTabLeases(state) {
  const leases = []
  for (const [tabId, sessionId] of state.tabLeases.entries()) {
    leases.push({ tabId, sessionId })
  }
  leases.sort((a, b) => a.tabId - b.tabId)
  return leases
}

function getStatusPayload(targetPort = null, preferAll = false) {
  if (targetPort !== null) {
    const state = getPortState(targetPort)
    if (!state) {
      return { ok: false, error: `No relay listener configured on port ${targetPort}` }
    }
    return getSinglePortStatus(state)
  }

  const summary = Array.from(portStates.values())
    .map(summarizePortState)
    .sort((a, b) => a.port - b.port)

  if (!preferAll && summary.length === 1) {
    return getSinglePortStatus(portStates.values().next().value)
  }

  const extensionPorts = summary.filter((entry) => entry.extensionConnected).map((entry) => entry.port)
  const extensionConnected = extensionPorts.length > 0
  const extensionLastSeenAgoMs =
    summary.find((entry) => typeof entry.extensionLastSeenAgoMs === 'number')
      ?.extensionLastSeenAgoMs ?? null
  const queuedControllerCommands = summary.reduce((total, entry) => total + entry.queuedControllerCommands, 0)

  return {
    ok: true,
    service: 'grais-debugger-relay',
    host,
    ports: summary,
    portCount: summary.length,
    extensionConnected,
    extensionLastSeenAgoMs,
    queuedControllerCommands,
    extensionPorts,
    activePorts: extensionPorts.length,
  }
}

function startPortListener(relayPort) {
  if (portStates.has(relayPort)) return Promise.resolve()
  if (!Number.isInteger(relayPort) || relayPort <= 0 || relayPort > 65535) {
    return Promise.reject(new Error(`Invalid relay port ${relayPort}`))
  }

  const state = createPortState(relayPort)
  const server = http.createServer((request, response) => {
    handleHttpRequest(request, response, state)
  })
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (socket) => {
    handleWebSocketConnection(socket, state)
  })

  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head, state, wss)
  })

  state.httpServer = server
  state.wss = wss
  portStates.set(relayPort, state)

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      portStates.delete(relayPort)
      reject(error)
    }
    server.once('error', onError)
    server.listen(relayPort, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function addRelayPorts(portsToAdd) {
  const normalized = [...new Set(portsToAdd)]
    .filter(Number.isInteger)
    .filter((port) => !portStates.has(port))
  for (const port of normalized) {
    await startPortListener(port)
    console.log(`Added relay listener on ${host}:${port}`)
  }
  return normalized
}

async function removeRelayPorts(portsToRemove) {
  const existing = [...new Set(portsToRemove)].filter((port) => portStates.has(port))
  for (const port of existing) {
    const state = portStates.get(port)
    if (!state) continue

    if (state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN) {
      state.extensionSocket.close(1000, 'relay port removed')
    }

    for (const controller of state.controllerSockets) {
      controller.close(1000, 'relay port removed')
    }
    state.controllerSockets.clear()

    failPending(state, 'Relay port removed')
    clearQueue(state)

    stopRelayHeartbeatWatchdog(state)

    await new Promise((resolve) => {
      state.wss.close(() => resolve())
    })

    await new Promise((resolve) => {
      state.httpServer.close(() => {
        resolve()
      })
    })

    portStates.delete(port)
    console.log(`Removed relay listener on ${host}:${port}`)
  }

  if (portStates.size === 0) {
    shutdown(0, 'All relay ports removed')
  }

  return existing
}

function parseTabId(value) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

function parseRelaySessionId(value) {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  return normalized
}

function createSessionId(state) {
  const suffix = state.nextSessionId
  state.nextSessionId += 1
  return `${SESSION_ID_PREFIX}-${state.relayPort}-${Date.now().toString(36)}-${suffix.toString(36)}`
}

function getSessionForSocket(state, socket) {
  for (const session of state.sessionsById.values()) {
    if (session.socket === socket) {
      return session
    }
  }
  return null
}

function releaseSessionTabLease(state, session) {
  if (!session || !Number.isInteger(session.leasedTabId)) return
  const activeSessionId = state.tabLeases.get(session.leasedTabId)
  if (activeSessionId === session.sessionId) {
    state.tabLeases.delete(session.leasedTabId)
  }
  session.leasedTabId = null
}

function closeSession(state, session, reason = 'Session closed') {
  if (!session) return
  releaseSessionTabLease(state, session)
  state.sessionsById.delete(session.sessionId)
  clearQueuedCommandsForSocket(state, session.socket, reason)
  failPending(state, reason, session.socket)
}

function closeSessionForSocket(state, socket, reason = 'Session closed') {
  const session = getSessionForSocket(state, socket)
  closeSession(state, session, reason)
}

function claimTabLease(state, session, tabId, force = false) {
  if (!session) {
    return { ok: false, error: 'Session is required to claim a tab lease' }
  }
  const normalizedTabId = parseTabId(tabId)
  if (!normalizedTabId) {
    return { ok: false, error: 'tabId must be a positive integer' }
  }
  const existingSessionId = state.tabLeases.get(normalizedTabId)
  if (existingSessionId && existingSessionId !== session.sessionId) {
    if (!force) {
      return { ok: false, error: `Tab ${normalizedTabId} is already leased by another session` }
    }
    const existingSession = state.sessionsById.get(existingSessionId)
    if (existingSession) {
      existingSession.leasedTabId = null
    }
    state.tabLeases.delete(normalizedTabId)
  }

  if (Number.isInteger(session.leasedTabId) && session.leasedTabId !== normalizedTabId) {
    state.tabLeases.delete(session.leasedTabId)
  }
  state.tabLeases.set(normalizedTabId, session.sessionId)
  session.leasedTabId = normalizedTabId

  return { ok: true, tabId: normalizedTabId, sessionId: session.sessionId }
}

function resolveSession(state, socket, params = {}, options = {}) {
  const requestedSessionId = parseRelaySessionId(params.sessionId)
  if (requestedSessionId) {
    const session = state.sessionsById.get(requestedSessionId)
    if (!session) return { ok: false, error: `Unknown session: ${requestedSessionId}` }
    if (session.socket !== socket) return { ok: false, error: 'Session is owned by a different controller' }
    return { ok: true, session }
  }

  const existing = getSessionForSocket(state, socket)
  if (existing) {
    return { ok: true, session: existing }
  }

  if (options.createIfMissing !== true) {
    return { ok: false, error: 'No relay session for this controller. Call Grais.relay.openSession first.' }
  }

  const sessionId = createSessionId(state)
  const session = {
    sessionId,
    socket,
    client: typeof params.client === 'string' ? params.client : null,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    leasedTabId: null,
  }
  state.sessionsById.set(sessionId, session)
  return { ok: true, session }
}

function listAttachedTabsWithLease(state) {
  const attachedTabs = Array.isArray(state.extensionHeartbeatState?.attachedTabs)
    ? state.extensionHeartbeatState.attachedTabs
    : []
  const tabs = []
  for (const tab of attachedTabs) {
    const tabId = parseTabId(tab?.tabId)
    if (!tabId) continue
    tabs.push({
      ...tab,
      tabId,
      leasedSessionId: state.tabLeases.get(tabId) || null,
    })
  }
  tabs.sort((a, b) => a.tabId - b.tabId)
  return tabs
}

function clearQueue(state) {
  for (const entry of state.queuedControllerRequests) {
    clearTimeout(entry.timer)
    const pending = state.pendingByRelayId.get(entry.relayId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingByRelayIdDelete(state, entry.relayId)
    }
  }
  state.queuedControllerRequests.length = 0
}

function parseAdminRequestBody(request, response, callback) {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (!raw) {
      callback(null, null)
      return
    }
    try {
      callback(null, JSON.parse(raw))
    } catch (error) {
      callback(error)
    }
  })
  request.on('error', (error) => callback(error))
}

function respondJson(response, statusCode, payload, method = 'GET') {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json')
  if (method === 'HEAD') {
    response.end('')
    return
  }
  response.end(JSON.stringify(payload))
}

function handleHttpRequest(request, response, state) {
  const method = request.method || 'GET'
  const requestUrl = new URL(request.url || '', `http://${request.headers.host || `${host}:${state.relayPort}`}`)
  const pathname = requestUrl.pathname

  if (pathname === '/status') {
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET,HEAD')
      return respondJson(response, 405, { ok: false, error: 'method_not_allowed' }, method)
    }
    const requestedPortRaw = requestUrl.searchParams.get('port')
    const requestedPort = requestedPortRaw !== null ? parsePortOrNull(requestedPortRaw) : null
    if (requestedPortRaw !== null && requestedPort === null) {
      return respondJson(response, 400, { ok: false, error: `Invalid query parameter port: ${requestedPortRaw}` }, method)
    }

    const preferAll = requestUrl.searchParams.get('all') === '1' || requestUrl.searchParams.get('all') === 'true'
    const status = getStatusPayload(requestedPort, preferAll)
    if (!status.ok && requestedPort !== null) {
      return respondJson(response, 404, status, method)
    }
    return respondJson(response, 200, status, method)
  }

  if (pathname === '/admin/ports') {
    if (method === 'GET' || method === 'HEAD') {
      const payload = {
        ok: true,
        host,
        ports: Array.from(portStates.keys()).sort((a, b) => a - b),
      }
      return respondJson(response, 200, payload, method)
    }

    if (method === 'POST') {
      parseAdminRequestBody(request, response, async (err, payload) => {
        if (err) {
          return respondJson(response, 400, { ok: false, error: 'Invalid JSON body' }, method)
        }

        const action = String(payload?.action || '').trim().toLowerCase()
        const bodyPorts = parsePortList(payload?.ports, [])
        const portsToManage = new Set([...bodyPorts])

        const single = parsePortOrNull(payload?.port)
        if (single !== null) portsToManage.add(single)

        if (!ALLOWED_ADMIN_ACTIONS.includes(action) || portsToManage.size === 0) {
          return respondJson(
            response,
            400,
            { ok: false, error: 'Payload requires action=add|remove and one or more ports' },
            method,
          )
        }

        let changedPorts
        try {
          if (action === 'add') {
            changedPorts = await addRelayPorts(Array.from(portsToManage))
          } else {
            changedPorts = await removeRelayPorts(Array.from(portsToManage))
          }
        } catch (error) {
          return respondJson(
            response,
            500,
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            method,
          )
        }

        const payloadOut = {
          ok: true,
          action,
          changedPorts,
          activePorts: Array.from(portStates.keys()).sort((a, b) => a - b),
          status: getStatusPayload(null, true),
        }
        return respondJson(response, 200, payloadOut, method)
      })
      return
    }

    response.setHeader('allow', 'GET,HEAD,POST')
    return respondJson(response, 405, { ok: false, error: 'method_not_allowed' }, method)
  }

  if (pathname !== '/' && pathname !== '') {
    response.statusCode = 404
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: false, error: 'not_found' }))
    return
  }

  if (method === 'GET' || method === 'HEAD') {
    return respondJson(response, 200, { ok: true, service: 'grais-debugger-relay' }, method)
  }

  response.setHeader('allow', 'GET,HEAD')
  return respondJson(response, 405, { ok: false, error: 'method_not_allowed' }, method)
}

function handleUpgrade(request, socket, head, state, wss) {
  const pathname = new URL(request.url || '', `http://${request.headers.host || `${host}:${state.relayPort}`}`).pathname
  if (pathname !== '/extension') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
}

function handleWebSocketConnection(socket, state) {
  const entry = {
    role: 'unknown',
    socket,
    seenAtMs: Date.now(),
    relayPort: state.relayPort,
  }
  socketMeta.set(socket, entry)
  state.controllerSockets.add(socket)

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }

    if (entry.role === 'unknown') {
      if (isControllerMessage(msg)) {
        entry.role = 'controller'
      } else if (isExtensionMessage(msg)) {
        entry.role = 'extension'
      } else {
        return
      }

      if (entry.role === 'extension') {
        entry.seenAtMs = Date.now()
        state.extensionLastSeenTs = entry.seenAtMs
        if (state.extensionSocket && state.extensionSocket !== socket && state.extensionSocket.readyState === state.extensionSocket.OPEN) {
          state.extensionSocket.close(1008, 'new_extension_client')
        }
        state.extensionSocket = socket
        startRelayHeartbeatWatchdog(state)
        notifyControllers(state, { method: 'relayEvent', params: { type: 'extension_connected', port: state.relayPort } })
        flushQueuedControllerCommands(state)
      }
    }

    if (entry.role === 'extension') {
      return onExtensionMessage(msg, socket, state)
    }
    if (entry.role === 'controller') {
      return onControllerMessage(msg, socket, state)
    }
    return
  })

  socket.on('close', () => {
    const wasExtension = state.extensionSocket === socket
    if (wasExtension) {
      state.extensionSocket = null
      state.extensionLastSeenTs = 0
      state.extensionHeartbeatState = null
      state.extensionSessionToTab.clear()
      stopRelayHeartbeatWatchdog(state)
      notifyControllers(state, { method: 'relayEvent', params: { type: 'extension_disconnected', port: state.relayPort } })
      failPending(state, 'Relay disconnected')
    } else {
      closeSessionForSocket(state, socket, 'Controller disconnected')
    }

    state.controllerSockets.delete(socket)
    socketMeta.delete(socket)
  })

  socket.on('error', () => {
    // Keep resilient.
  })
}

function onExtensionMessage(msg, socket, state) {
  const now = Date.now()
  const entry = socketMeta.get(socket)
  if (entry) entry.seenAtMs = now
  state.extensionLastSeenTs = now

  if (msg && msg.method === 'Grais.extensionHeartbeat') {
    state.extensionHeartbeatState = {
      ts: now,
      relayPort: Number.isFinite(Number(msg.relayPort)) ? Number(msg.relayPort) : state.relayPort,
      activeTab: cleanTabMeta(msg.activeTab),
      attachedTabs: Array.isArray(msg.attachedTabs)
        ? msg.attachedTabs.map((entry) => sanitizeTabMeta(entry)).filter(Boolean)
        : [],
      state: String(msg.state || 'attached'),
      status: String(msg.status || ''),
      allowTargetCreate: msg.allowTargetCreate === true,
      extensionVersion: typeof msg.extensionVersion === 'string' ? msg.extensionVersion : null,
      extensionName: typeof msg.extensionName === 'string' ? msg.extensionName : null,
      extensionCapabilities:
        msg.extensionCapabilities && typeof msg.extensionCapabilities === 'object' ? msg.extensionCapabilities : null,
    }
    refreshExtensionSessionMap(state)
    return
  }

  if (msg && typeof msg.id === 'number') {
    console.log('[Relay] extension response', { relayId: msg.id, port: state.relayPort })
    const pending = state.pendingByRelayId.get(msg.id)
    if (!pending) return

    const payload = {
      id: pending.requestId,
      ...(msg.result !== undefined ? { result: msg.result } : {}),
      ...(msg.error !== undefined ? { error: msg.error } : {}),
    }

    clearTimeout(pending.timer)
    pendingByRelayIdDelete(state, msg.id)
    safeSend(pending.socket, payload)
    return
  }

  if (msg && msg.method === 'forwardCDPEvent') {
    updateExtensionSessionMapFromEvent(state, msg)
    routeExtensionEventToControllers(state, msg)
    return
  }

  if (msg && msg.method === 'pong') {
    return
  }
}

function onControllerMessage(msg, socket, state) {
  if (msg && msg.method === 'ping') {
    safeSend(socket, { method: 'pong' })
    return
  }

  const relayControl = handleControllerRelayMethod(msg, socket, state)
  if (relayControl.handled) {
    if (typeof msg?.id === 'number') {
      if (relayControl.ok) {
        safeSend(socket, { id: msg.id, result: relayControl.result })
      } else {
        safeSend(socket, { id: msg.id, error: relayControl.error || 'Relay control command failed' })
      }
    }
    return
  }

  const forward = toRelayPayload(msg)
  if (!forward) return

  const binding = bindForwardCommandToSessionLease(state, socket, forward)
  if (!binding.ok) {
    throwErrorToController(socket, forward.id, binding.error || 'Relay command rejected')
    return
  }

  if (!state.extensionSocket || state.extensionSocket.readyState !== state.extensionSocket.OPEN) {
    queueControllerCommand(state, binding.forward, socket)
    return
  }

  forwardControllerToExtension(state, binding.forward, socket)
}

function handleControllerRelayMethod(msg, socket, state) {
  if (!msg || typeof msg.method !== 'string' || !msg.method.startsWith('Grais.relay.')) {
    return { handled: false }
  }
  if (typeof msg.id !== 'number') {
    return { handled: true, ok: false, error: 'Relay control commands require numeric id' }
  }

  const params = typeof msg.params === 'object' && msg.params !== null ? msg.params : {}
  if (msg.method === 'Grais.relay.openSession') {
    const resolved = resolveSession(state, socket, params, { createIfMissing: true })
    if (!resolved.ok) return { handled: true, ok: false, error: resolved.error }
    const session = resolved.session
    session.lastSeenAt = Date.now()
    const requestedTabId = parseTabId(params.tabId)
    if (requestedTabId) {
      const lease = claimTabLease(state, session, requestedTabId, params.force === true)
      if (!lease.ok) return { handled: true, ok: false, error: lease.error }
    }
    return {
      handled: true,
      ok: true,
      result: {
        ok: true,
        sessionId: session.sessionId,
        tabId: Number.isInteger(session.leasedTabId) ? session.leasedTabId : null,
        relayPort: state.relayPort,
      },
    }
  }

  if (msg.method === 'Grais.relay.closeSession') {
    const resolved = resolveSession(state, socket, params, { createIfMissing: false })
    if (!resolved.ok) return { handled: true, ok: false, error: resolved.error }
    const closedSessionId = resolved.session.sessionId
    closeSession(state, resolved.session, 'Session closed by controller')
    return { handled: true, ok: true, result: { ok: true, sessionId: closedSessionId } }
  }

  if (msg.method === 'Grais.relay.claimTab') {
    const resolved = resolveSession(state, socket, params, { createIfMissing: false })
    if (!resolved.ok) return { handled: true, ok: false, error: resolved.error }
    const session = resolved.session
    session.lastSeenAt = Date.now()
    const lease = claimTabLease(state, session, params.tabId, params.force === true)
    if (!lease.ok) return { handled: true, ok: false, error: lease.error }
    return {
      handled: true,
      ok: true,
      result: {
        ok: true,
        sessionId: session.sessionId,
        tabId: session.leasedTabId,
      },
    }
  }

  if (msg.method === 'Grais.relay.releaseTab') {
    const resolved = resolveSession(state, socket, params, { createIfMissing: false })
    if (!resolved.ok) return { handled: true, ok: false, error: resolved.error }
    const session = resolved.session
    const requestedTabId = parseTabId(params.tabId)
    if (requestedTabId && session.leasedTabId !== requestedTabId) {
      return {
        handled: true,
        ok: false,
        error: `Session ${session.sessionId} does not currently lease tab ${requestedTabId}`,
      }
    }
    const releasedTabId = session.leasedTabId
    releaseSessionTabLease(state, session)
    return {
      handled: true,
      ok: true,
      result: {
        ok: true,
        sessionId: session.sessionId,
        tabId: Number.isInteger(releasedTabId) ? releasedTabId : null,
      },
    }
  }

  if (msg.method === 'Grais.relay.getSession') {
    const resolved = resolveSession(state, socket, params, { createIfMissing: false })
    if (!resolved.ok) return { handled: true, ok: false, error: resolved.error }
    const session = resolved.session
    return {
      handled: true,
      ok: true,
      result: {
        ok: true,
        sessionId: session.sessionId,
        tabId: Number.isInteger(session.leasedTabId) ? session.leasedTabId : null,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      },
    }
  }

  if (msg.method === 'Grais.relay.listTabs') {
    return {
      handled: true,
      ok: true,
      result: {
        ok: true,
        activeTab: state.extensionHeartbeatState?.activeTab || null,
        attachedTabs: listAttachedTabsWithLease(state),
        tabLeases: summarizeTabLeases(state),
      },
    }
  }

  return { handled: true, ok: false, error: `Unsupported relay control method: ${msg.method}` }
}

function bindForwardCommandToSessionLease(state, socket, forward) {
  if (!forward || forward.method !== 'forwardCDPCommand') {
    return { ok: true, forward }
  }
  const payloadParams = typeof forward.params === 'object' && forward.params !== null ? forward.params : {}
  forward.params = payloadParams

  const relaySessionId = parseRelaySessionId(payloadParams.relaySessionId)
  if (!relaySessionId) {
    return { ok: true, forward }
  }

  const session = state.sessionsById.get(relaySessionId)
  if (!session) {
    return { ok: false, error: `Unknown relay session: ${relaySessionId}` }
  }
  if (session.socket !== socket) {
    return { ok: false, error: 'Relay session is owned by a different controller' }
  }
  session.lastSeenAt = Date.now()

  let targetTabId = parseTabId(payloadParams.tabId)
  if (targetTabId) {
    const lease = claimTabLease(state, session, targetTabId, false)
    if (!lease.ok) {
      return { ok: false, error: lease.error }
    }
  } else if (Number.isInteger(session.leasedTabId)) {
    targetTabId = session.leasedTabId
  } else {
    return {
      ok: false,
      error: `No tab lease for session ${relaySessionId}. Claim a tab or include params.tabId.`,
    }
  }

  payloadParams.tabId = targetTabId
  if (typeof payloadParams.method === 'string') {
    const methodParams = typeof payloadParams.params === 'object' && payloadParams.params !== null
      ? payloadParams.params
      : {}
    if (
      payloadParams.method === 'Grais.debugger.attachTab' ||
      payloadParams.method === 'Grais.debugger.ensureActiveTab' ||
      payloadParams.method === 'Grais.debugger.getActiveTabMetadata'
    ) {
      methodParams.tabId = targetTabId
      payloadParams.params = methodParams
    }
  }

  return { ok: true, forward }
}

function refreshExtensionSessionMap(state) {
  state.extensionSessionToTab.clear()
  const attachedTabs = Array.isArray(state.extensionHeartbeatState?.attachedTabs)
    ? state.extensionHeartbeatState.attachedTabs
    : []
  for (const attached of attachedTabs) {
    const tabId = parseTabId(attached?.tabId)
    const sessionId = typeof attached?.sessionId === 'string' ? attached.sessionId.trim() : ''
    if (tabId && sessionId) {
      state.extensionSessionToTab.set(sessionId, tabId)
    }
  }
}

function updateExtensionSessionMapFromEvent(state, message) {
  if (!message || message.method !== 'forwardCDPEvent') return
  const payload = message.params
  const tabId = parseTabId(payload?.tabId)
  const topSessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  if (tabId && topSessionId) {
    state.extensionSessionToTab.set(topSessionId, tabId)
  }

  if (payload?.method === 'Target.attachedToTarget') {
    const nestedSessionId = typeof payload?.params?.sessionId === 'string' ? payload.params.sessionId.trim() : ''
    if (tabId && nestedSessionId) {
      state.extensionSessionToTab.set(nestedSessionId, tabId)
    }
  } else if (payload?.method === 'Target.detachedFromTarget') {
    const nestedSessionId = typeof payload?.params?.sessionId === 'string' ? payload.params.sessionId.trim() : ''
    if (nestedSessionId) {
      state.extensionSessionToTab.delete(nestedSessionId)
    }
  }
}

function resolveEventTabId(state, message) {
  const explicitTabId = parseTabId(message?.params?.tabId)
  if (explicitTabId) return explicitTabId

  const topSessionId = typeof message?.params?.sessionId === 'string' ? message.params.sessionId.trim() : ''
  if (topSessionId) {
    const mapped = state.extensionSessionToTab.get(topSessionId)
    if (Number.isInteger(mapped)) return mapped
  }

  const nestedSessionId = typeof message?.params?.params?.sessionId === 'string'
    ? message.params.params.sessionId.trim()
    : ''
  if (nestedSessionId) {
    const mapped = state.extensionSessionToTab.get(nestedSessionId)
    if (Number.isInteger(mapped)) return mapped
  }

  return null
}

function routeExtensionEventToControllers(state, message) {
  const eventTabId = resolveEventTabId(state, message)
  if (!eventTabId) {
    sendEventToSingleControllerIfSafe(state, message)
    return
  }

  const leasedSessionId = state.tabLeases.get(eventTabId)
  if (!leasedSessionId) {
    sendEventToSingleControllerIfSafe(state, message)
    return
  }

  const session = state.sessionsById.get(leasedSessionId)
  if (!session || session.socket.readyState !== session.socket.OPEN) {
    sendEventToSingleControllerIfSafe(state, message)
    return
  }
  safeSend(session.socket, message)
}

function sendEventToSingleControllerIfSafe(state, message) {
  const controllers = []
  for (const controller of state.controllerSockets) {
    if (controller === state.extensionSocket) continue
    if (controller.readyState !== controller.OPEN) continue
    controllers.push(controller)
  }
  if (controllers.length === 1) {
    safeSend(controllers[0], message)
  }
}

function queueControllerCommand(state, forward, socket) {
  while (state.queuedControllerRequests.length >= MAX_QUEUED_CONTROLLER_COMMANDS) {
    const overflow = state.queuedControllerRequests.shift()
    if (!overflow) break
    clearTimeout(overflow.timer)
    pendingByRelayIdDelete(state, overflow.relayId)
    throwErrorToController(overflow.socket, overflow.requestId, 'Relay queue full; command dropped')
  }

  const relayId = state.nextRelayId
  state.nextRelayId += 1
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
      dequeueControllerCommand(state, relayId, `Relay has no active extension connection for ${QUEUED_REQUEST_TIMEOUT_MS}ms`)
    }, QUEUED_REQUEST_TIMEOUT_MS),
  }

  state.queuedControllerRequests.push(queueEntry)
  state.pendingByRelayId.set(relayId, {
    socket,
    requestId: forward.id,
    timer: queueEntry.timer,
  })

  notifyControllers(state, {
    method: 'relayEvent',
    params: {
      type: 'extension_offline_queue',
      port: state.relayPort,
      queue: state.queuedControllerRequests.length,
      requestId: forward.id,
    },
  })
}

function dequeueControllerCommand(state, relayId, reason) {
  const index = state.queuedControllerRequests.findIndex((entry) => entry.relayId === relayId)
  if (index === -1) return
  const entry = state.queuedControllerRequests[index]
  state.queuedControllerRequests.splice(index, 1)
  clearTimeout(entry.timer)
  const pending = state.pendingByRelayId.get(relayId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingByRelayIdDelete(state, relayId)
  }
  throwErrorToController(entry.socket, entry.requestId, reason)
}

function clearQueuedCommandsForSocket(state, socket, reason = 'Controller disconnected') {
  for (let index = state.queuedControllerRequests.length - 1; index >= 0; index -= 1) {
    const entry = state.queuedControllerRequests[index]
    if (entry.socket !== socket) continue
    state.queuedControllerRequests.splice(index, 1)
    clearTimeout(entry.timer)
    const pending = state.pendingByRelayId.get(entry.relayId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingByRelayIdDelete(state, entry.relayId)
    }
    throwErrorToController(entry.socket, entry.requestId, reason)
  }
}

function flushQueuedControllerCommands(state) {
  if (!state.extensionSocket || state.extensionSocket.readyState !== state.extensionSocket.OPEN) return

  while (state.queuedControllerRequests.length > 0) {
    const entry = state.queuedControllerRequests.shift()
    if (!entry) return
    const pending = state.pendingByRelayId.get(entry.relayId)
    if (!pending) {
      clearTimeout(entry.timer)
      continue
    }

    clearTimeout(pending.timer)
    state.pendingByRelayId.set(entry.relayId, {
      ...pending,
      timer: setTimeout(() => {
        pendingByRelayIdDelete(state, entry.relayId)
        throwErrorToController(entry.socket, entry.requestId, `Relay timed out after ${requestTimeoutMs}ms`)
      }, requestTimeoutMs),
    })

    const replayPending = state.pendingByRelayId.get(entry.relayId)
    if (!replayPending) {
      clearTimeout(entry.timer)
      continue
    }

    try {
      sendToExtension(state, entry.payload)
    } catch (error) {
      clearTimeout(replayPending.timer)
      clearTimeout(entry.timer)
      pendingByRelayIdDelete(state, entry.relayId)
      throwErrorToController(
        entry.socket,
        entry.requestId,
        `Failed to dispatch queued command: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function forwardControllerToExtension(state, forward, socket) {
  const relayId = state.nextRelayId
  state.nextRelayId += 1
  console.log('[Relay] forwarding to extension', {
    relayId,
    requestId: forward.id,
    method: forward.method,
    port: state.relayPort,
  })
  const payload = {
    id: relayId,
    method: forward.method,
    params: forward.params,
  }

  state.pendingByRelayId.set(relayId, {
    socket,
    requestId: forward.id,
    timer: setTimeout(() => {
      pendingByRelayIdDelete(state, relayId)
      throwErrorToController(socket, forward.id, `Relay timed out after ${requestTimeoutMs}ms`)
    }, requestTimeoutMs),
  })

  const pending = state.pendingByRelayId.get(relayId)
  if (!pending) return
  try {
    sendToExtension(state, payload)
  } catch (error) {
    clearTimeout(pending.timer)
    pendingByRelayIdDelete(state, relayId)
    if (!state.extensionSocket || state.extensionSocket.readyState !== state.extensionSocket.OPEN) {
      queueControllerCommand(state, forward, socket)
      return
    }
    throwErrorToController(
      socket,
      forward.id,
      `Failed to dispatch command: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function sendToExtension(state, payload) {
  if (!state.extensionSocket || state.extensionSocket.readyState !== state.extensionSocket.OPEN) {
    throw new Error('Relay has no active extension connection')
  }
  console.log('[Relay] sendToExtension', {
    id: payload?.id,
    method: payload?.method,
    hasParams: Boolean(payload?.params),
    port: state.relayPort,
  })
  state.extensionSocket.send(JSON.stringify(payload))
}

function failPending(state, reason, socket) {
  for (const [relayId, pending] of state.pendingByRelayId.entries()) {
    if (socket && pending.socket !== socket) {
      continue
    }

    clearTimeout(pending.timer)
    state.pendingByRelayId.delete(relayId)
    throwErrorToController(pending.socket, pending.requestId, reason)
  }
}

function pendingByRelayIdDelete(state, relayId) {
  const pending = state.pendingByRelayId.get(relayId)
  if (!pending) return
  clearTimeout(pending.timer)
  state.pendingByRelayId.delete(relayId)
}

function toRelayPayload(msg) {
  if (typeof msg !== 'object' || msg === null) return null
  if (typeof msg.id !== 'number') return null
  if (typeof msg.method !== 'string') return null
  const { id, method, params } = msg
  if (!method) return null
  return { id, method, params }
}

function isControllerMessage(msg) {
  if (typeof msg !== 'object' || msg === null) return false
  if (msg && msg.method === 'ping') return true
  if (msg && typeof msg.id === 'number' && typeof msg.method === 'string') return true
  return false
}

function isExtensionMessage(msg) {
  if (typeof msg !== 'object' || msg === null) return false
  if (msg && msg.method === 'forwardCDPEvent') return true
  if (msg && msg.method === 'Grais.extensionHeartbeat') return true
  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) return true
  return false
}

function notifyControllers(state, message) {
  for (const controller of state.controllerSockets) {
    if (controller !== state.extensionSocket) {
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
    // best effort
  }
}

function startRelayHeartbeatWatchdog(state) {
  if (state.relayHeartbeatWatchdog) return
  state.relayHeartbeatWatchdog = setInterval(() => {
    if (!state.extensionSocket || state.extensionSocket.readyState !== state.extensionSocket.OPEN) return
    if (!state.extensionLastSeenTs) return
    const elapsed = Date.now() - state.extensionLastSeenTs
    if (elapsed > RELAY_HEARTBEAT_TIMEOUT_MS) {
      state.extensionSocket.close(1001, 'heartbeat timeout')
    }
  }, RELAY_HEARTBEAT_INTERVAL_MS)
}

function stopRelayHeartbeatWatchdog(state) {
  if (!state.relayHeartbeatWatchdog) return
  clearInterval(state.relayHeartbeatWatchdog)
  state.relayHeartbeatWatchdog = null
}

function shutdown(exitCode = 0, message) {
  if (shuttingDown) return
  shuttingDown = true
  if (message) {
    console.log(message)
  }
  stopAutoShutdownTimer()
  if (autoShutdownTimer) {
    clearTimeout(autoShutdownTimer)
    autoShutdownTimer = null
  }

  for (const state of portStates.values()) {
    failPending(state, 'Relay shutting down')
    if (state.extensionSocket && state.extensionSocket.readyState === state.extensionSocket.OPEN) {
      state.extensionSocket.close(1001, 'relay shutdown')
    }
    for (const controller of state.controllerSockets) {
      if (controller !== state.extensionSocket) {
        controller.close(1001, 'relay shutdown')
      }
    }
    clearQueue(state)
    stopRelayHeartbeatWatchdog(state)
    state.wss.close()
    if (state.httpServer) {
      state.httpServer.close()
    }
  }

  setTimeout(() => {
    releaseRelayLock()
    process.exit(exitCode)
  }, 50)
}

function stopAutoShutdownTimer() {
  if (!autoShutdownTimer) return
  clearTimeout(autoShutdownTimer)
  autoShutdownTimer = null
}

function parsePortOrNull(value) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return null
  return parsed
}

function parsePortList(raw, fallback) {
  if (raw == null || raw === '') return fallback.slice()
  const values = String(raw).split(',')
  const ports = []
  for (const value of values) {
    const parsed = parsePortOrNull(value)
    if (Number.isInteger(parsed)) ports.push(parsed)
  }
  return ports.length > 0 ? ports : fallback.slice()
}

function getRelayLockPath(hostname) {
  const safeHost = String(hostname || DEFAULT_HOST).replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(os.tmpdir(), `grais-debugger-relay-${safeHost}.lock`)
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
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), host }))
      return fd
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      const existing = readRelayLockFile(filePath)
      const pid = Number.parseInt(String(existing?.pid || ''), 10)
      if (Number.isInteger(pid) && isProcessAlive(pid)) {
        throw new Error(`Another relay process is already running on host ${host} (pid ${pid})`)
      }
      try {
        fs.unlinkSync(filePath)
      } catch {
        // best effort
      }
    }
  }
  throw new Error(`Failed to acquire relay lock for host ${host}`)
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

function sanitizeTabMeta(value) {
  if (!value || typeof value !== 'object') return null
  const url = typeof value.url === 'string' ? value.url : null
  const title = typeof value.title === 'string' ? value.title : null
  const tabId = Number.isInteger(Number(value.tabId)) ? Number(value.tabId) : null
  const windowId = Number.isInteger(Number(value.windowId)) ? Number(value.windowId) : null
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : null
  const targetId = typeof value.targetId === 'string' ? value.targetId : null
  const state = typeof value.state === 'string' ? value.state : null
  return {
    tabId,
    url,
    title,
    windowId,
    sessionId,
    targetId,
    state,
  }
}

function cleanTabMeta(value) {
  if (!value) return null
  const metadata = sanitizeTabMeta(value)
  if (!metadata || metadata.tabId === null) return null
  return metadata
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

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--port' && argv[i + 1]) out.port = argv[++i]
    else if (arg === '--ports' && argv[i + 1]) out.ports = argv[++i]
    else if (arg === '--host' && argv[i + 1]) out.host = argv[++i]
    else if (arg === '--timeout' && argv[i + 1]) out.timeout = argv[++i]
    else if (arg === '--max-runtime-ms' && argv[i + 1]) out.maxRuntimeMs = argv[++i]
  }
  return out
}

process.on('SIGINT', () => {
  shutdown(0)
})

process.on('SIGTERM', () => {
  shutdown(0)
})

process.on('exit', () => {
  releaseRelayLock()
})
