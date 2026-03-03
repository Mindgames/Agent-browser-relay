const DEFAULT_PORT = 18793
const RECOVERABLE_SEND_RETRIES = 2
const RECOVER_RETRY_DELAY_MS = 600
const TAB_RECOVER_AUTO_REATTACH_DELAY_MS = 250
const ATTACH_COMMAND_TIMEOUT_MS = 8000
const DEBUGGER_COMMAND_TIMEOUT_MS = 3000
const RELAY_HEARTBEAT_MS = 2500
const RELAY_RECONNECT_BASE_DELAY_MS = 500
const RELAY_RECONNECT_MAX_DELAY_MS = 10000
const FORWARD_COMMAND_TIMEOUT_MS = 10000
const DEBUG_LOG = true
const ALLOW_FOREGROUND_ACTIVATE_TARGET = false
const RELAY_PORT_BY_TAB_KEY = 'relayPortByTab'
const ALLOW_TARGET_CREATE_KEY = 'allowTargetCreate'
const EXTENSION_CAPABILITIES = Object.freeze({
  bridgeMethods: [
    'Grais.debugger.ensureActiveTab',
    'Grais.debugger.attachTab',
    'Grais.debugger.getActiveTabMetadata',
    'Grais.relay.openSession',
    'Grais.relay.closeSession',
    'Grais.relay.claimTab',
    'Grais.relay.releaseTab',
  ],
  cdpMethods: [
    'Runtime.enable',
    'Runtime.evaluate',
    'Page.captureScreenshot',
    'Target.createTarget',
    'Target.closeTarget',
    'Target.activateTarget',
  ],
  presets: ['default', 'whatsapp', 'whatsapp-messages', 'wa', 'chat-audit', 'chat'],
})

const BADGE = {
  on: { text: 'ON', color: '#16A34A' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
/** @type {Map<number, Promise<void>>} */
const autoAttachPromises = new Map()
/** @type {number|null} */
let relayReconnectTimer = null
/** @type {number} */
let relayReconnectAttempts = 0
/** @type {number|null} */
let activeTabAutoReattachTimer = null
/** @type {number|null} */
let activeTabAutoReattachEventTimer = null
/** @type {number|null} */
let relayHeartbeatTimer = null

const manualDetachTabs = new Set()

let debuggerListenersInstalled = false
/** @type {boolean} */
let userAttachmentEnabled = false
/** @type {number|null} */
let userPinnedTabId = null
/** @type {boolean} */
let allowTargetCreate = false

let nextSession = 1
let currentRelayPort = DEFAULT_PORT
let suppressRelayReconnectForPortSwitch = false

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getRelayPortConfig() {
  const stored = await chrome.storage.local.get(['relayPort', RELAY_PORT_BY_TAB_KEY])
  const defaultPort = parseRelayPort(stored.relayPort, DEFAULT_PORT)
  return { defaultPort, tabPorts: sanitizeRelayPortMap(stored[RELAY_PORT_BY_TAB_KEY] || {}) }
}

function parseRelayPort(value, fallback = DEFAULT_PORT) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return Number.isFinite(fallback) ? fallback : NaN
  }
  return parsed
}

function sanitizeRelayPortMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const tabId = Number.parseInt(String(key || ''), 10)
    const port = parseRelayPort(value, NaN)
    if (Number.isInteger(tabId) && Number.isInteger(port)) {
      out[tabId] = port
    }
  }
  return out
}

async function getRelayPort(tabId = null) {
  const { defaultPort, tabPorts } = await getRelayPortConfig()
  if (!Number.isInteger(tabId)) return defaultPort
  const mapped = parseRelayPort(tabPorts[tabId], defaultPort)
  return mapped
}

async function setRelayPortForTab(tabId, port) {
  const resolvedTabId = normalizeTabId(tabId)
  if (!Number.isInteger(resolvedTabId)) return
  const safePort = parseRelayPort(port, DEFAULT_PORT)
  const stored = await chrome.storage.local.get([RELAY_PORT_BY_TAB_KEY])
  const source = stored[RELAY_PORT_BY_TAB_KEY]
  const nextMap = sanitizeRelayPortMap(source || {})
  nextMap[resolvedTabId] = safePort
  await chrome.storage.local.set({ [RELAY_PORT_BY_TAB_KEY]: nextMap })
}

async function clearRelayPortForTab(tabId) {
  const resolvedTabId = normalizeTabId(tabId)
  if (!Number.isInteger(resolvedTabId)) return
  const stored = await chrome.storage.local.get([RELAY_PORT_BY_TAB_KEY])
  const source = stored[RELAY_PORT_BY_TAB_KEY]
  const nextMap = sanitizeRelayPortMap(source || {})
  if (!(resolvedTabId in nextMap)) return
  delete nextMap[resolvedTabId]
  await chrome.storage.local.set({ [RELAY_PORT_BY_TAB_KEY]: nextMap })
}

async function getUserAttachmentPref() {
  const stored = await chrome.storage.local.get(['userAttachmentEnabled'])
  return stored.userAttachmentEnabled === true
}

async function setUserAttachmentPref(enabled) {
  await chrome.storage.local.set({ userAttachmentEnabled: Boolean(enabled) })
}

async function getPinnedTabPref() {
  const stored = await chrome.storage.local.get(['userPinnedTabId'])
  return normalizeTabId(stored.userPinnedTabId)
}

async function setPinnedTabPref(tabId) {
  const normalized = normalizeTabId(tabId)
  if (normalized === null) {
    await chrome.storage.local.remove(['userPinnedTabId'])
    return
  }
  await chrome.storage.local.set({ userPinnedTabId: normalized })
}

async function getAllowTargetCreatePref() {
  const stored = await chrome.storage.local.get([ALLOW_TARGET_CREATE_KEY])
  return stored[ALLOW_TARGET_CREATE_KEY] === true
}

async function setAllowTargetCreatePref(enabled) {
  allowTargetCreate = Boolean(enabled)
  await chrome.storage.local.set({ [ALLOW_TARGET_CREATE_KEY]: allowTargetCreate })
}

async function disableAttachmentState() {
  userAttachmentEnabled = false
  userPinnedTabId = null
  stopRelayReconnectLoop()
  relayReconnectAttempts = 0
  await Promise.allSettled([
    setUserAttachmentPref(false),
    setPinnedTabPref(null),
  ])
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

function refreshTabIndicator(tabId) {
  const normalizedTabId = normalizeTabId(tabId)
  if (!Number.isInteger(normalizedTabId)) return
  const state = tabs.get(normalizedTabId)?.state || null
  if (state === 'connected') {
    setBadge(normalizedTabId, 'on')
    void chrome.action.setTitle({
      tabId: normalizedTabId,
      title: 'Agent Browser Relay: attached (click to detach)',
    })
    return
  }
  if (state === 'connecting') {
    setBadge(normalizedTabId, 'connecting')
    void chrome.action.setTitle({
      tabId: normalizedTabId,
      title: 'Agent Browser Relay: attaching to active tab…',
    })
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function dbg(...args) {
  if (!DEBUG_LOG) return
  try {
    console.log('[Agent Browser Relay]', ...args)
  } catch {
    // no-op
  }
}

function withTimeout(work, label, timeoutMs) {
  return Promise.race([
    work,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }),
  ])
}

function isRecoverableDebuggerError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase()
  if (!message) return false
  return (
    message.includes('no tab with id') ||
    message.includes('no target with id') ||
    message.includes('target closed') ||
    message.includes('context was destroyed') ||
    message.includes('execution context') ||
    message.includes('detached') ||
    message.includes('cannot find context') ||
    message.includes('chrome remote debugging session') ||
    message.includes('inspector detached')
  )
}

async function getActiveTabId() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (typeof active?.id === 'number') return active.id

  const [fallback] = await chrome.tabs.query({ active: true })
  return typeof fallback?.id === 'number' ? fallback.id : null
}

async function resolvePinnedTabId() {
  if (!Number.isInteger(userPinnedTabId)) return null
  const pinnedTab = await chrome.tabs.get(userPinnedTabId).catch(() => null)
  if (pinnedTab?.id) return pinnedTab.id
  const fallbackPinnedTabId = pickPreferredPinnedTabId(userPinnedTabId)
  if (Number.isInteger(fallbackPinnedTabId)) {
    userPinnedTabId = fallbackPinnedTabId
    await setPinnedTabPref(fallbackPinnedTabId)
    return fallbackPinnedTabId
  }
  await disableAttachmentState()
  return null
}

function normalizeTabId(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}

function pickPreferredPinnedTabId(excludeTabId = null) {
  let preferredTabId = null
  let preferredOrder = -1
  for (const [tabId, tab] of tabs.entries()) {
    if (Number.isInteger(excludeTabId) && tabId === excludeTabId) continue
    if (tab?.state !== 'connected' && tab?.state !== 'connecting') continue
    const attachOrder = Number.isFinite(Number(tab?.attachOrder)) ? Number(tab.attachOrder) : 0
    if (preferredTabId === null || attachOrder >= preferredOrder) {
      preferredTabId = tabId
      preferredOrder = attachOrder
    }
  }
  return preferredTabId
}

async function syncAttachmentPrefs() {
  userAttachmentEnabled = tabs.size > 0
  if (!userAttachmentEnabled) {
    await disableAttachmentState()
    return
  }

  if (!Number.isInteger(userPinnedTabId) || !tabs.has(userPinnedTabId)) {
    userPinnedTabId = pickPreferredPinnedTabId()
  }

  if (!Number.isInteger(userPinnedTabId)) {
    await disableAttachmentState()
    return
  }

  await Promise.allSettled([
    setUserAttachmentPref(true),
    setPinnedTabPref(userPinnedTabId),
  ])
}

function scheduleActiveTabReattachFromEvent() {
  if (!userAttachmentEnabled) return
  if (!Number.isInteger(userPinnedTabId)) return
  if (activeTabAutoReattachEventTimer) {
    clearTimeout(activeTabAutoReattachEventTimer)
  }

  activeTabAutoReattachEventTimer = setTimeout(() => {
    activeTabAutoReattachEventTimer = null
    void ensureActiveTabAndRelayConnection({ force: false }).catch(() => {})
  }, 120)
}

async function ensureActiveTabAndRelayConnection({ force = false } = {}) {
  dbg('ensureActiveTabAndRelayConnection', { force })
  if (!userAttachmentEnabled) return
  const pinnedTabId = await resolvePinnedTabId()
  if (!pinnedTabId) return
  try {
    await ensureRelayConnection(pinnedTabId)
  } catch {
    return
  }

  if (!force && manualDetachTabs.has(pinnedTabId)) return

  try {
    await ensureActiveTabAttachedFromRelay({ force, tabId: pinnedTabId })
  } catch {
    // best effort while relay is transiently unavailable
  }
}

function resolveTabIdByCommand(sessionId, targetId) {
  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  return (
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()
  )
}

function clearTabMappings(tabId) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId) {
    tabBySession.delete(tab.sessionId)
  }
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
  return tab
}

async function recoverTabStateFromDetach(tabId) {
  if (!tabId) return
  clearTabMappings(tabId)
  await chrome.debugger.detach({ tabId }).catch(() => {})
  await syncAttachmentPrefs()
  await sleep(TAB_RECOVER_AUTO_REATTACH_DELAY_MS)
  try {
    const preferredTabId = Number.isInteger(userPinnedTabId) ? userPinnedTabId : tabId
    await ensureActiveTabAttachedFromRelay({ force: true, tabId: preferredTabId })
  } catch {
    // best effort
  }
}

async function switchRelayConnectionForTab(targetTabId) {
  const targetPort = await getRelayPort(targetTabId)
  if (currentRelayPort === targetPort && relayWs && relayWs.readyState === WebSocket.OPEN) return

  if (!relayWs || relayWs.readyState === WebSocket.CLOSED || relayWs.readyState === WebSocket.CLOSING) {
    currentRelayPort = targetPort
    return
  }

  if (relayWs.readyState === WebSocket.OPEN || relayWs.readyState === WebSocket.CONNECTING) {
    suppressRelayReconnectForPortSwitch = true
    relayWs.close(1000, `switch relay port to ${targetPort}`)
    await sleep(60)
  }

  while (relayWs && relayWs.readyState !== WebSocket.CLOSED && relayWs.readyState !== WebSocket.CLOSING) {
    await sleep(30)
  }
  currentRelayPort = targetPort
}

async function ensureRelayConnection(tabId = null) {
  dbg('ensureRelayConnection.start')
  const targetPort = await getRelayPort(tabId)
  let switchedRelayPort = false
  if (!relayWs) {
    currentRelayPort = targetPort
  } else if (relayWs.readyState !== WebSocket.OPEN || currentRelayPort !== targetPort) {
    switchedRelayPort = true
    await switchRelayConnectionForTab(tabId)
  }

  if (relayWs && relayWs.readyState === WebSocket.OPEN && currentRelayPort === targetPort) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = targetPort
    currentRelayPort = port
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension`

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    dbg('ensureRelayConnection.connecting', { port })
    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')
    startRelayHeartbeat()

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
    if (switchedRelayPort) suppressRelayReconnectForPortSwitch = false
  }
}

function onRelayClosed(reason) {
  dbg('relayClosed', reason)
  stopRelayHeartbeat()
  stopRelayReconnectLoop()
  relayWs = null
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  for (const tabId of tabs.keys()) {
    void chrome.debugger.detach({ tabId }).catch(() => {})
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'Agent Browser Relay: disconnected (click to re-attach)',
    })
  }
  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()
  relayReconnectAttempts = 0

  if (userAttachmentEnabled && !suppressRelayReconnectForPortSwitch) {
    startRelayReconnectLoop()
  }

  if (suppressRelayReconnectForPortSwitch) {
    suppressRelayReconnectForPortSwitch = false
  }
}

function startRelayHeartbeat() {
  stopRelayHeartbeat()
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return

  void sendRelayHeartbeat().catch((error) => {
    dbg('relayHeartbeat.failed', { error: error instanceof Error ? error.message : String(error) })
  })

  relayHeartbeatTimer = setInterval(() => {
    void sendRelayHeartbeat().catch((error) => {
      dbg('relayHeartbeat.failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }, RELAY_HEARTBEAT_MS)
}

function stopRelayHeartbeat() {
  if (!relayHeartbeatTimer) return
  clearInterval(relayHeartbeatTimer)
  relayHeartbeatTimer = null
}

async function sendRelayHeartbeat() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
  const activeTab = await buildActiveHeartbeatTab()
  const attachedTabs = await buildAttachedHeartbeatTabs()
  const manifest = typeof chrome?.runtime?.getManifest === 'function' ? chrome.runtime.getManifest() : null
  refreshTabIndicator(activeTab?.tabId)
  const payload = {
    method: 'Grais.extensionHeartbeat',
    ts: Date.now(),
    relayPort: currentRelayPort,
    state: userAttachmentEnabled ? 'attached' : 'detached',
    status: userAttachmentEnabled ? 'ON' : 'OFF',
    activeTab,
    attachedTabs,
    extensionVersion: manifest && typeof manifest.version === 'string' ? manifest.version : null,
    extensionName: manifest && typeof manifest.name === 'string' ? manifest.name : null,
    extensionCapabilities: EXTENSION_CAPABILITIES,
  }
  sendToRelay(payload)
}

async function buildActiveHeartbeatTab() {
  try {
    const candidates = await chrome.tabs.query({ active: true, currentWindow: true })
    const active = Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : null
    return sanitizeHeartbeatTab(active)
  } catch {
    return null
  }
}

async function buildAttachedHeartbeatTabs() {
  const entries = [...tabs.entries()].filter(([, tab]) => tab?.state === 'connected')
  const attached = []
  for (const [tabId, tab] of entries) {
    const candidate = await chrome.tabs.get(tabId).catch(() => null)
    const base = sanitizeHeartbeatTab(candidate)
    if (!base) continue
    attached.push({
      ...base,
      sessionId: typeof tab?.sessionId === 'string' ? tab.sessionId : null,
      targetId: typeof tab?.targetId === 'string' ? tab.targetId : null,
      state: tab?.state || 'connected',
    })
  }
  return attached
}

function sanitizeHeartbeatTab(tab) {
  if (!tab || typeof tab !== 'object') return null
  const tabId = typeof tab.id === 'number' && Number.isInteger(tab.id) ? tab.id : null
  if (!tabId) return null
  return {
    tabId,
    url: typeof tab.url === 'string' ? tab.url : null,
    title: typeof tab.title === 'string' ? tab.title : null,
    windowId: typeof tab.windowId === 'number' && Number.isInteger(tab.windowId) ? tab.windowId : null,
  }
}

function startRelayReconnectLoop() {
  dbg('startRelayReconnectLoop', { enabled: userAttachmentEnabled, attempts: relayReconnectAttempts })
  if (!userAttachmentEnabled) return
  if (relayReconnectTimer) return

  const delay = Math.min(
    RELAY_RECONNECT_MAX_DELAY_MS,
    RELAY_RECONNECT_BASE_DELAY_MS * (2 ** Math.min(relayReconnectAttempts, 6)),
  )
  relayReconnectTimer = setTimeout(() => {
    relayReconnectTimer = null
    if (!userAttachmentEnabled) return

    void (async () => {
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayReconnectAttempts = 0
        return
      }

      try {
        const pinnedTabId = await resolvePinnedTabId()
        await ensureRelayConnection(pinnedTabId)
        await ensureActiveTabAttachedFromRelay({ force: true, tabId: pinnedTabId || undefined })
        relayReconnectAttempts = 0
        stopRelayReconnectLoop()
      } catch {
        relayReconnectAttempts += 1
        startRelayReconnectLoop()
      }
    })()
  }, delay)
}

function stopRelayReconnectLoop() {
  if (!relayReconnectTimer) return
  clearTimeout(relayReconnectTimer)
  relayReconnectTimer = null
}

function scheduleAutoAttachFromDetach(reason, tabId) {
  dbg('scheduleAutoAttachFromDetach', { reason, tabId })
  if (!userAttachmentEnabled) return
  if (reason === 'toggle' || reason === 'recovery') return
  if (Number.isInteger(userPinnedTabId) && tabId !== userPinnedTabId) return
  if (!tabId || manualDetachTabs.has(tabId)) return
  if (activeTabAutoReattachTimer) {
    clearTimeout(activeTabAutoReattachTimer)
  }
  activeTabAutoReattachTimer = setTimeout(() => {
    void ensureActiveTabAttachedFromRelay({ force: true }).catch(() => {})
  }, 250)
}

function sendToRelay(payload) {
  dbg('sendToRelay', { method: payload?.method, id: payload?.id })
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  dbg('requestFromRelay', { id: command?.id, method: command?.method })
  const id = command.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      sendToRelay(command)
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    dbg('relayMessage.ping')
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    dbg('relayMessage.result', { id: msg.id, hasError: Boolean(msg.error) })
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    dbg('relayMessage.forwardCDPCommand', { id: msg.id, method: msg?.params?.method, sessionId: msg?.params?.sessionId })
    try {
      const result = await withTimeout(handleForwardCdpCommand(msg), 'forwardCDPCommand', FORWARD_COMMAND_TIMEOUT_MS)
      try {
        sendToRelay({ id: msg.id, result })
      } catch {
        // If relay is unavailable, command will timeout in caller.
      }
    } catch (err) {
      try {
        sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
      } catch {
        // If relay is unavailable, command will timeout in caller.
      }
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  dbg('attachTab.start', { tabId, skipAttachedEvent: Boolean(opts.skipAttachedEvent) })
  const debuggee = { tabId }
  await withTimeout(
    chrome.debugger.attach(debuggee, '1.3'),
    `attach(${tabId})`,
    ATTACH_COMMAND_TIMEOUT_MS,
  )
  await withTimeout(
    chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {}),
    `Page.enable(${tabId})`,
    DEBUGGER_COMMAND_TIMEOUT_MS,
  ).catch(() => {})

  const info = /** @type {any} */ (
    await withTimeout(
      chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'),
      `Target.getTargetInfo(${tabId})`,
      DEBUGGER_COMMAND_TIMEOUT_MS,
    )
  )
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sessionId = `cb-tab-${nextSession++}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
    void chrome.action.setTitle({
      tabId,
      title: 'Agent Browser Relay: attached (click to detach)',
    })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        tabId,
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  dbg('attachTab.success', { tabId, sessionId, targetId })
  return { sessionId, targetId }
}

async function ensureActiveTabAttachedFromRelay({ force = false, tabId } = {}) {
  dbg('ensureActiveTabAttachedFromRelay.start', { force, tabId })
  const targetTabId = Number.isInteger(tabId) ? tabId : await resolvePinnedTabId()
  if (!targetTabId) {
    throw new Error('No pinned tab selected. Click Agent Browser Relay on the target tab to attach.')
  }
  await ensureRelayConnection(targetTabId)
  manualDetachTabs.delete(targetTabId)

  const activeTab = tabs.get(targetTabId)
  if (activeTab?.state === 'connected') return
  if (!force && activeTab?.state === 'connecting') return
  const existingAttachPromise = autoAttachPromises.get(targetTabId)
  if (existingAttachPromise) return await existingAttachPromise

  const attachPromise = (async () => {
    if (!force) {
      const latestActiveTab = tabs.get(targetTabId)
      if (latestActiveTab?.state === 'connected' || latestActiveTab?.state === 'connecting') {
        return
      }
    }

    const activeState = tabs.get(targetTabId)
    if (activeState?.state === 'connected' && !force) return

    tabs.set(targetTabId, { state: 'connecting' })
    setBadge(targetTabId, 'connecting')
    void chrome.action.setTitle({
      tabId: targetTabId,
      title: 'Agent Browser Relay: attaching to active tab…',
    })
    try {
      await attachTab(targetTabId, { skipAttachedEvent: true })
      await setRelayPortForTab(targetTabId, currentRelayPort)
    } catch (err) {
      dbg('ensureActiveTabAttachedFromRelay.fail', {
        tabId: targetTabId,
        error: err instanceof Error ? err.message : String(err),
      })
      tabs.delete(targetTabId)
      throw err instanceof Error ? err : new Error(String(err))
    }
  })()
  autoAttachPromises.set(targetTabId, attachPromise)

  try {
    await attachPromise
  } finally {
    autoAttachPromises.delete(targetTabId)
  }
}

async function detachTab(tabId, reason) {
  dbg('detachTab', { tabId, reason })
  const tab = tabs.get(tabId)
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          tabId,
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
    void chrome.action.setTitle({
      tabId,
      title: 'Agent Browser Relay (click to attach/detach)',
    })
}

async function connectOrToggleForActiveTab(tab) {
  console.log('[Agent Browser Relay] toolbar icon clicked', {
    clickedTabId: Number.isInteger(tab?.id) ? tab.id : null,
    clickedTabUrl: tab?.url || null,
    clickedWindowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
    pinnedTabId: userPinnedTabId,
    userAttachmentEnabled,
    mode: Number.isInteger(tab?.id) ? 'explicit' : 'active-tab-fallback',
  })

  const tabId = Number.isInteger(tab?.id) ? tab.id : await getActiveTabId()
  if (!tabId) return

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    dbg('connectOrToggleForActiveTab.toggleOff', { tabId })
    manualDetachTabs.add(tabId)
    await detachTab(tabId, 'toggle')
    manualDetachTabs.delete(tabId)
    await syncAttachmentPrefs()
    return
  }

  userPinnedTabId = tabId
  await setPinnedTabPref(tabId)

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'Agent Browser Relay: connecting to local relay…',
    })

  try {
    dbg('connectOrToggleForActiveTab.connectStart', { tabId })
    userPinnedTabId = tabId
    stopRelayReconnectLoop()
    relayReconnectAttempts = 0
    await ensureRelayConnection(tabId)
    await attachTab(tabId)
    await setRelayPortForTab(tabId, currentRelayPort)
    userAttachmentEnabled = true
    userPinnedTabId = tabId
    await setUserAttachmentPref(true)
    await setPinnedTabPref(tabId)
    manualDetachTabs.delete(tabId)
    stopRelayReconnectLoop()
    relayReconnectAttempts = 0
  } catch (err) {
    dbg('connectOrToggleForActiveTab.connectFail', { tabId, error: err instanceof Error ? err.message : String(err) })
    tabs.delete(tabId)
    await syncAttachmentPrefs()
    setBadge(tabId, 'error')
    void chrome.action.setTitle({
      tabId,
      title: 'Agent Browser Relay: relay not running (open options for setup)',
    })
    void maybeOpenHelpOnce()
    // Extra breadcrumbs in chrome://extensions service worker logs.
    const message = err instanceof Error ? err.message : String(err)
    console.warn('attach failed', message, nowStack())
  }
}

async function handleForwardCdpCommand(msg) {
  dbg('handleForwardCdpCommand.start', { id: msg?.id, method: msg?.params?.method })
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined
  const requestedTabId = normalizeTabId(msg?.params?.tabId)

  if (method === 'Grais.debugger.ensureActiveTab') {
    dbg('handleForwardCdpCommand.ensureActiveTab')
    await ensureActiveTabAttachedFromRelay({ force: false, tabId: requestedTabId || undefined })
    return { ok: true }
  }

  if (method === 'Grais.debugger.attachTab') {
    if (!requestedTabId) {
      return {
        ok: false,
        error: 'Grais.debugger.attachTab requires params.tabId',
      }
    }
    await ensureActiveTabAttachedFromRelay({ force: true, tabId: requestedTabId })
    const attached = tabs.get(requestedTabId)
    if (!attached?.sessionId || !attached.targetId) {
      return {
        ok: false,
        error: `Failed to attach tab ${requestedTabId}`,
      }
    }
    return {
      ok: true,
      tabId: requestedTabId,
      sessionId: attached.sessionId,
      targetId: attached.targetId,
    }
  }

  if (method === 'Grais.debugger.getActiveTabMetadata') {
    dbg('handleForwardCdpCommand.getActiveTabMetadata')
    const explicitTabId = requestedTabId !== null ? requestedTabId : await resolvePinnedTabId()
    if (!explicitTabId) {
      return {
        ok: false,
        error: 'No pinned tab selected. Click Agent Browser Relay on the target tab to attach.',
      }
    }
    const tab = await chrome.tabs.get(explicitTabId).catch(() => null)
    if (!tab) return { ok: false, error: 'Pinned tab not found' }

    return {
      ok: true,
      tabId: explicitTabId,
      url: tab.url || null,
      title: tab.title || null,
      status: tab.status || null,
      audible: Boolean(tab.audible),
      muted: Boolean(tab.mutedInfo?.muted),
      windowId: tab.windowId,
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),
    }
  }

  const hasExplicitBinding =
    typeof sessionId === 'string' || typeof params?.targetId === 'string' || requestedTabId !== null
  if (!hasExplicitBinding && userAttachmentEnabled && tabs.size === 0) {
    await ensureActiveTabAttachedFromRelay({ force: false })
  }

  let attempt = 0
  while (attempt < RECOVERABLE_SEND_RETRIES) {
    dbg('handleForwardCdpCommand.attempt', { attempt, method, methodTarget: params?.targetId, sessionId })
    if (tabs.size === 0) {
      dbg('handleForwardCdpCommand.attachFromZero', { method, requestedTabId })
      await ensureActiveTabAttachedFromRelay({ force: true, tabId: requestedTabId || undefined })
    }

    const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
    let tabId = null

    if (requestedTabId !== null) {
      // Lease-bound commands must always execute on the explicitly requested tab.
      tabId = requestedTabId
      if (!tabs.has(tabId) || tabs.get(tabId)?.state !== 'connected') {
        await ensureActiveTabAttachedFromRelay({ force: true, tabId })
      }
    } else {
      tabId = resolveTabIdByCommand(sessionId, targetId)
    }

    if (!tabId) {
      dbg('handleForwardCdpCommand.noTab', { method, sessionId, targetId: params?.targetId })
      await ensureActiveTabAttachedFromRelay({ force: true, tabId: requestedTabId || undefined })
      attempt += 1
      await sleep(TAB_RECOVER_AUTO_REATTACH_DELAY_MS)
      continue
    }

    /** @type {chrome.debugger.DebuggerSession} */
    const debuggee = { tabId }

    if (method === 'Runtime.enable') {
      dbg('handleForwardCdpCommand.runtimeEnable', { tabId })
      try {
        await withTimeout(
          chrome.debugger.sendCommand(debuggee, 'Runtime.disable'),
          `Runtime.disable(${tabId})`,
          DEBUGGER_COMMAND_TIMEOUT_MS,
        )
        await new Promise((r) => setTimeout(r, 50))
      } catch {
        // ignore
      }
      try {
        return await withTimeout(
          chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params),
          `Runtime.enable(${tabId})`,
          DEBUGGER_COMMAND_TIMEOUT_MS,
        )
      } catch (err) {
        if (isRecoverableDebuggerError(err) && attempt + 1 < RECOVERABLE_SEND_RETRIES) {
          await recoverTabStateFromDetach(tabId)
          attempt += 1
          continue
        }
        throw err
      }
    }

    if (method === 'Target.createTarget') {
      if (!allowTargetCreate) {
        throw new Error('Target.createTarget is disabled. Enable "Allow agent to open new background tabs" in the popup.')
      }
      const url = typeof params?.url === 'string' ? params.url : 'about:blank'
      dbg('handleForwardCdpCommand.targetCreate', { requestedUrl: url })
      const tab = await chrome.tabs.create({ url, active: false })
      if (!tab.id) throw new Error('Failed to create tab')
      await new Promise((r) => setTimeout(r, 100))
      const attached = await attachTab(tab.id)
      return { targetId: attached.targetId }
    }

    if (method === 'Target.closeTarget') {
      const target = typeof params?.targetId === 'string' ? params.targetId : ''
      dbg('handleForwardCdpCommand.targetClose', { target })
      const toClose = target ? getTabByTargetId(target) : tabId
      if (!toClose) return { success: false }
      try {
        await chrome.tabs.remove(toClose)
      } catch {
        return { success: false }
      }
      return { success: true }
    }

    if (method === 'Target.activateTarget') {
      const target = typeof params?.targetId === 'string' ? params.targetId : ''
      dbg('handleForwardCdpCommand.targetActivate', {
        target,
        allowForeground: ALLOW_FOREGROUND_ACTIVATE_TARGET,
      })
      const toActivate = target ? getTabByTargetId(target) : tabId
      if (!toActivate) return {}
      if (!ALLOW_FOREGROUND_ACTIVATE_TARGET) return {}
      const tab = await chrome.tabs.get(toActivate).catch(() => null)
      if (!tab) return {}
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      }
      await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
      return {}
    }

    const tabState = tabs.get(tabId)
    const mainSessionId = tabState?.sessionId
    const debuggerSession =
      sessionId && mainSessionId && sessionId !== mainSessionId
        ? { ...debuggee, sessionId }
        : debuggee

    try {
      dbg('handleForwardCdpCommand.sendCommand', { tabId, method })
      return await withTimeout(
        chrome.debugger.sendCommand(debuggerSession, method, params),
        `${method}(${tabId})`,
        DEBUGGER_COMMAND_TIMEOUT_MS,
      )
    } catch (err) {
      dbg('handleForwardCdpCommand.sendCommandError', {
        tabId,
        method,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      })
      if (isRecoverableDebuggerError(err) && attempt + 1 < RECOVERABLE_SEND_RETRIES) {
        attempt += 1
        await recoverTabStateFromDetach(tabId)
        continue
      }
      throw err
    }
  }

  throw new Error(`No attached tab for method ${method}`)
}

async function initializeAttachmentState() {
  try {
    const [shouldBeAttached, pinnedTabPref, allowTargetCreatePref] = await Promise.all([
      getUserAttachmentPref(),
      getPinnedTabPref(),
      getAllowTargetCreatePref(),
    ])
    userAttachmentEnabled = Boolean(shouldBeAttached)
    userPinnedTabId = pinnedTabPref
    allowTargetCreate = Boolean(allowTargetCreatePref)
    if (!shouldBeAttached) return
    if (!Number.isInteger(userPinnedTabId)) {
      await disableAttachmentState()
      return
    }
    const pinnedTab = await chrome.tabs.get(userPinnedTabId).catch(() => null)
    if (!pinnedTab?.id) {
      await disableAttachmentState()
      return
    }
    await ensureActiveTabAndRelayConnection({ force: false })
    startRelayReconnectLoop()
  } catch {
    // best effort
  }
}

function onDebuggerEvent(source, method, params) {
  dbg('onDebuggerEvent', { tabId: source?.tabId, method })
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        tabId,
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  dbg('onDebuggerDetach', { tabId: source?.tabId, reason })
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return
  const wasPinnedTab = Number.isInteger(userPinnedTabId) && tabId === userPinnedTabId
  void detachTab(tabId, reason)
  if (manualDetachTabs.has(tabId)) {
    manualDetachTabs.delete(tabId)
    void syncAttachmentPrefs()
    return
  }
  void syncAttachmentPrefs()
  if (!wasPinnedTab) return
  scheduleAutoAttachFromDetach(reason, tabId)
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  refreshTabIndicator(activeInfo?.tabId)
  scheduleActiveTabReattachFromEvent()
})

chrome.tabs.onUpdated.addListener((_, changeInfo, tab) => {
  if (!tab?.active) return
  if (changeInfo.status !== 'complete') return
  refreshTabIndicator(tab.id)
  scheduleActiveTabReattachFromEvent()
})

chrome.tabs.onRemoved.addListener((removedTabId) => {
  void clearRelayPortForTab(removedTabId)
  clearTabMappings(removedTabId)
  if (removedTabId === userPinnedTabId || userAttachmentEnabled) {
    void syncAttachmentPrefs()
  }
})

chrome.action.onClicked.addListener((tab) => void connectOrToggleForActiveTab(tab))

void initializeAttachmentState()

chrome.runtime.onInstalled.addListener(() => {
  void Promise.allSettled([
    setUserAttachmentPref(false),
    setPinnedTabPref(null),
    setAllowTargetCreatePref(false),
  ])
  // Useful: first-time instructions.
  void chrome.runtime.openOptionsPage()
})

async function getPopupState(tabId, includeAllTabs = true) {
  const requestedTabId = normalizeTabId(tabId)
  const relayConnected = relayWs && relayWs.readyState === WebSocket.OPEN
  const { defaultPort, tabPorts } = await getRelayPortConfig()

  let activeTab = null
  if (Number.isInteger(requestedTabId)) {
    activeTab = await chrome.tabs.get(requestedTabId).catch(() => null)
  }

  const connectedTabs = []
  const entries = includeAllTabs ? [...tabs.entries()] : requestedTabId ? [[requestedTabId, tabs.get(requestedTabId)]] : []
  for (const [entryTabId, tabState] of entries) {
    if (!tabState) continue
    const tab = await chrome.tabs.get(entryTabId).catch(() => null)
    const base = sanitizeHeartbeatTab(tab)
    if (!base) continue
    connectedTabs.push({
      ...base,
      state: tabState.state || 'unknown',
      port: await getRelayPort(entryTabId),
    })
  }

  const mappedPort = Number.isInteger(requestedTabId) ? parseRelayPort(tabPorts[requestedTabId], NaN) : NaN
  const effectivePort = Number.isInteger(requestedTabId)
    ? await getRelayPort(requestedTabId)
    : defaultPort

  return {
    requestedTabId,
    activeTab: activeTab
      ? {
          tabId: activeTab.id,
          title: activeTab.title || null,
          url: activeTab.url || null,
          windowId: activeTab.windowId,
        }
      : null,
    defaultPort,
    relayPortConnected: relayConnected ? currentRelayPort : null,
    mappedPort: Number.isInteger(mappedPort) ? mappedPort : null,
    effectivePort: Number.isInteger(effectivePort) ? effectivePort : defaultPort,
    userAttachmentEnabled,
    allowTargetCreate,
    activeTabState: requestedTabId && tabs.get(requestedTabId)?.state ? tabs.get(requestedTabId).state : null,
    connectedTabs,
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('grais.popup.')) {
    return false
  }

  void (async () => {
    try {
      if (message.type === 'grais.popup.getState') {
        const state = await getPopupState(message.tabId, Boolean(message.includeAllTabs))
        sendResponse({ ok: true, ...state })
        return
      }

      if (message.type === 'grais.popup.setTabPort') {
        const tabId = normalizeTabId(message.tabId)
        const port = parseRelayPort(message.port, NaN)
        if (!Number.isInteger(tabId)) {
          throw new Error('Invalid tab id')
        }
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error('Invalid relay port')
        }
        await setRelayPortForTab(tabId, port)
        const state = await getPopupState(tabId, true)
        sendResponse({ ok: true, ...state })
        return
      }

      if (message.type === 'grais.popup.clearTabPort') {
        const tabId = normalizeTabId(message.tabId)
        if (!Number.isInteger(tabId)) {
          throw new Error('Invalid tab id')
        }
        await clearRelayPortForTab(tabId)
        const state = await getPopupState(tabId, true)
        sendResponse({ ok: true, ...state })
        return
      }

      if (message.type === 'grais.popup.toggleTabAttachment') {
        const tabId = normalizeTabId(message.tabId)
        if (!Number.isInteger(tabId)) {
          throw new Error('Invalid tab id')
        }
        await connectOrToggleForActiveTab({ id: tabId })
        const state = await getPopupState(tabId, true)
        const wasAttached = state.activeTabState === 'connected'
        sendResponse({ ok: true, attached: wasAttached, ...state })
        return
      }

      if (message.type === 'grais.popup.setTargetCreateEnabled') {
        const enabled = message.enabled === true
        await setAllowTargetCreatePref(enabled)
        const state = await getPopupState(message.tabId, true)
        sendResponse({ ok: true, ...state })
        return
      }

      sendResponse({ ok: false, error: `Unknown popup action: ${message.type}` })
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()

  return true
})
