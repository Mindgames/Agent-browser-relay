#!/usr/bin/env node
/* eslint-disable no-console */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { refreshInstallBundle } = require('./extension-install-helper')

const PROJECT_RELEASES_URL = 'https://github.com/Mindgames/agent-browser-relay/releases/latest'

const SKILL_CAPABILITIES = Object.freeze({
  name: 'agent-browser-relay',
  type: 'chrome-tab-read',
  cliCapabilities: [
    '--check',
    '--check --wait-for-attach',
    '--check --require-target-create',
    '--metadata',
    '--screenshot',
    '--screenshot-full-page',
    '--expression',
    '--preset',
    '--tab-id',
    '--wait-for-attach',
  ],
  relayMethods: [
    'Grais.relay.openSession',
    'Grais.relay.closeSession',
    'Grais.relay.claimTab',
    'Grais.relay.releaseTab',
    'Grais.relay.listTabs',
  ],
  bridgeMethods: [
    'Grais.debugger.ensureActiveTab',
    'Grais.debugger.attachTab',
    'Grais.debugger.getActiveTabMetadata',
  ],
  cdpMethods: [
    'Runtime.evaluate',
    'Runtime.enable',
    'Page.captureScreenshot',
    'Target.createTarget',
    'Target.closeTarget',
    'Target.activateTarget',
  ],
  presets: ['default', 'whatsapp', 'whatsapp-messages', 'wa', 'chat-audit', 'chat'],
  extractorFields: ['url', 'title', 'text', 'links', 'metaDescription'],
})

const DEFAULT_PORT = 18793
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 400
const DEFAULT_ATTACH_TIMEOUT_MS = 120000
const DEFAULT_ATTACH_POLL_MS = 500
const DEFAULT_STATUS_TIMEOUT_MS = 1200
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 15000

const DEFAULT_MAX_LINKS = 20
const DEFAULT_MAX_TEXT_CHARS = 8000
const DEFAULT_MESSAGE_MAX_MESSAGES = 500
const DEFAULT_PRESET = 'default'

const PRESET_WHATSAPP_MESSAGES = 'whatsapp-messages'
const PRESET_CHAT_AUDIT = 'chat-audit'

const args = process.argv.slice(2)
const options = parseArgs(args)

let installBundle = {
  ok: false,
  path: null,
  pathKind: null,
  sourcePath: null,
  visiblePath: null,
  installedVersion: null,
  visibleVersion: null,
  sourceVersion: null,
  relayVersion: null,
  versionMismatch: false,
  updated: false,
  sourceMissing: false,
  copyFailed: false,
  visiblePathReady: false,
  visiblePathNeedsRefresh: false,
}

if (options.help) {
  printUsage()
  process.exit(0)
}

const relayHost = String(options.host || DEFAULT_HOST).trim() || DEFAULT_HOST
const relayPort = parsePositiveInt(options.port, DEFAULT_PORT, 'port')
const relayStatusUrl = `http://${relayHost}:${relayPort}/status`
const relayWebSocketUrl = `ws://${relayHost}:${relayPort}/extension`
const timeoutMs = parsePositiveInt(options.timeout, DEFAULT_TIMEOUT_MS, 'timeout')
const pretty = options.pretty !== false
const selector = options.selector || 'body'
const maxLinks = parsePositiveInt(options.maxLinks, DEFAULT_MAX_LINKS, 'max-links')
const maxTextChars = parsePositiveInt(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 'max-text-chars')
const maxRetries = parsePositiveInt(options.retries, DEFAULT_RETRIES, 'retries')
const retryDelayMs = parsePositiveInt(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 'retry-delay-ms')
const checkOnly = options.check === true
const waitForAttach = options.waitForAttach === true
const requireTargetCreate = options.requireTargetCreate === true
const metadataOnly = options.metadata === true
const screenshotOnly =
  options.screenshot === true ||
  options.screenshotPath !== undefined ||
  options.screenshotFormat !== undefined ||
  options.screenshotQuality !== undefined ||
  options.screenshotFullPage === true ||
  options.screenshotTimeoutMs !== undefined
const attachTimeoutMs = parseNonNegativeInt(
  options.attachTimeoutMs,
  waitForAttach ? DEFAULT_ATTACH_TIMEOUT_MS : 0,
  'attach-timeout-ms',
)
const attachPollMs = parsePositiveInt(options.attachPollMs, DEFAULT_ATTACH_POLL_MS, 'attach-poll-ms')
const statusTimeoutMs = parsePositiveInt(options.statusTimeoutMs, DEFAULT_STATUS_TIMEOUT_MS, 'status-timeout-ms')
const screenshotPath = typeof options.screenshotPath === 'string' ? options.screenshotPath.trim() : ''
const screenshotOutputPath = screenshotPath.length > 0 ? screenshotPath : null
const screenshotFormat = resolveScreenshotFormat(options.screenshotFormat, screenshotOutputPath)
const screenshotQuality = parseScreenshotQuality(options.screenshotQuality, screenshotFormat)
const screenshotFullPage = options.screenshotFullPage === true
const screenshotTimeoutMs = parsePositiveInt(
  options.screenshotTimeoutMs,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
  'screenshot-timeout-ms',
)
const preset = String(options.preset || DEFAULT_PRESET).trim().toLowerCase()
const requestedTabId = parseOptionalTabId(options.tabId || process.env.GRAIS_TAB_ID, 'tab-id')

const textRegex = parseRegexOption('text-regex', options.textRegex, options.textRegexFlags)
const excludeTextRegex = parseRegexOption('exclude-text-regex', options.excludeTextRegex, options.excludeTextRegexFlags)
const linkTextRegex = parseRegexOption('link-text-regex', options.linkTextRegex, options.linkTextRegexFlags)
const linkHrefRegex = parseRegexOption('link-href-regex', options.linkHrefRegex, options.linkHrefRegexFlags)
const messageRegex = parseRegexOption('message-regex', options.messageRegex, options.messageRegexFlags)
const excludeMessageRegex = parseRegexOption(
  'exclude-message-regex',
  options.excludeMessageRegex,
  options.excludeMessageRegexFlags,
)
const senderRegex = parseRegexOption('sender-regex', options.senderRegex, options.senderRegexFlags)
const excludeSenderRegex = parseRegexOption(
  'exclude-sender-regex',
  options.excludeSenderRegex,
  options.excludeSenderRegexFlags,
)
const maxMessages = parsePositiveInt(options.maxMessages, DEFAULT_MESSAGE_MAX_MESSAGES, 'max-messages')

const expression =
  options.expression ||
  buildBridgeExpression({
    preset,
    selector,
    textRegex,
    excludeTextRegex,
    linkTextRegex,
    linkHrefRegex,
    maxLinks,
    maxTextChars,
    messageRegex,
    excludeMessageRegex,
    senderRegex,
    excludeSenderRegex,
    maxMessages,
  })

const wsUrl = relayWebSocketUrl
const socket = new WebSocket(wsUrl)

const pending = new Map()
const pendingPongs = []
let nextId = 1

let activeSocket = false
let rejectAllPending
let relaySessionId = null
let leasedTabId = Number.isInteger(requestedTabId) ? requestedTabId : null
let relayStatusSnapshot = null

function getRelaySource() {
  const observedExtensionVersion = getObservedExtensionVersion()
  const expectedExtensionVersion = installBundle.sourceVersion || installBundle.relayVersion || installBundle.installedVersion || null
  const extensionMismatch =
    typeof observedExtensionVersion === 'string' && typeof expectedExtensionVersion === 'string'
      ? observedExtensionVersion !== expectedExtensionVersion
      : false
  return {
    relayHost,
    relayPort,
    relayStatusUrl,
    relayWebSocketUrl,
    relaySessionId,
    tabId: Number.isInteger(leasedTabId) ? leasedTabId : null,
    capabilities: SKILL_CAPABILITIES,
    extension: {
      installPath: installBundle.path,
      loadPath: installBundle.path,
      loadPathKind: installBundle.pathKind,
      installRootPath: installBundle.rootPath,
      sourcePath: installBundle.sourcePath,
      visiblePath: installBundle.visiblePath,
      readActiveTabPath: installBundle.readActiveTabPath,
      preflightPath: installBundle.preflightPath,
      relayManagerPath: installBundle.relayManagerPath,
      installedVersion: installBundle.installedVersion,
      visibleVersion: installBundle.visibleVersion,
      sourceVersion: installBundle.sourceVersion,
      relayVersion: installBundle.relayVersion,
      observedExtensionVersion,
      expectedExtensionVersion,
      observedCapabilities: relayStatusSnapshot?.extensionCapabilities
        && typeof relayStatusSnapshot.extensionCapabilities === 'object'
        ? relayStatusSnapshot.extensionCapabilities
        : null,
      observedVersionMismatch: extensionMismatch,
      updated: Boolean(installBundle.updated),
      versionMismatch: Boolean(installBundle.versionMismatch || extensionMismatch),
      copyFailed: Boolean(installBundle.copyFailed),
      visiblePathReady: Boolean(installBundle.visiblePathReady),
      visiblePathNeedsRefresh: Boolean(installBundle.visiblePathNeedsRefresh),
    },
  }
}

function getObservedExtensionVersion() {
  if (!relayStatusSnapshot || typeof relayStatusSnapshot !== 'object') return null
  if (typeof relayStatusSnapshot.extensionVersion === 'string') return relayStatusSnapshot.extensionVersion
  if (!Array.isArray(relayStatusSnapshot.ports)) return null
  for (const entry of relayStatusSnapshot.ports) {
    if (!entry || typeof entry !== 'object') continue
    if (Number(entry.port) !== relayPort) continue
    if (typeof entry.extensionVersion === 'string') return entry.extensionVersion
  }
  return null
}

socket.addEventListener('open', () => {
  activeSocket = true
})

socket.addEventListener('close', (event) => {
  activeSocket = false
  if (rejectAllPending) {
    rejectAllPending(new Error(`Relay closed (${event.code}: ${event.reason || 'no reason'})`))
  }
})

socket.addEventListener('message', (event) => {
  let msg
  try {
    msg = JSON.parse(event.data)
  } catch {
    return
  }

  if (msg && msg.method === 'pong') {
    const waiter = pendingPongs.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
      return
    }
  }

  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    const entry = pending.get(msg.id)
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) {
      entry.reject(new Error(String(msg.error)))
      return
    }
    entry.resolve(msg.result ?? null)
  }
})

socket.addEventListener('error', (error) => {
  console.error('Relay websocket error', error.message || error)
})

function parseArgs(argv) {
  const out = { pretty: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--host' && argv[i + 1]) out.host = argv[++i]
    else if (arg === '--port' && argv[i + 1]) out.port = argv[++i]
    else if (arg === '--timeout' && argv[i + 1]) out.timeout = argv[++i]
    else if (arg === '--selector' && argv[i + 1]) out.selector = argv[++i]
    else if (arg === '--expression' && argv[i + 1]) out.expression = argv[++i]
    else if (arg === '--preset' && argv[i + 1]) out.preset = argv[++i]
    else if (arg === '--tab-id' && argv[i + 1]) out.tabId = argv[++i]
    else if (arg === '--pretty' && argv[i + 1]) out.pretty = argv[++i] !== 'false'
    else if (arg === '--wait-for-attach') out.waitForAttach = true
    else if (arg === '--require-target-create') out.requireTargetCreate = true
    else if (arg === '--attach-timeout-ms' && argv[i + 1]) out.attachTimeoutMs = argv[++i]
    else if (arg === '--attach-poll-ms' && argv[i + 1]) out.attachPollMs = argv[++i]
    else if (arg === '--metadata') out.metadata = true
    else if (arg === '--screenshot') out.screenshot = true
    else if (arg === '--screenshot-path' && argv[i + 1]) out.screenshotPath = argv[++i]
    else if (arg === '--screenshot-format' && argv[i + 1]) out.screenshotFormat = argv[++i]
    else if (arg === '--screenshot-quality' && argv[i + 1]) out.screenshotQuality = argv[++i]
    else if (arg === '--screenshot-timeout-ms' && argv[i + 1]) out.screenshotTimeoutMs = argv[++i]
    else if (arg === '--screenshot-full-page') out.screenshotFullPage = true

    else if (arg === '--text-regex' && argv[i + 1]) out.textRegex = argv[++i]
    else if (arg === '--text-regex-flags' && argv[i + 1]) out.textRegexFlags = argv[++i]
    else if (arg === '--message-regex' && argv[i + 1]) out.messageRegex = argv[++i]
    else if (arg === '--message-regex-flags' && argv[i + 1]) out.messageRegexFlags = argv[++i]
    else if (arg === '--exclude-message-regex' && argv[i + 1]) out.excludeMessageRegex = argv[++i]
    else if (arg === '--exclude-message-regex-flags' && argv[i + 1]) out.excludeMessageRegexFlags = argv[++i]
    else if (arg === '--sender-regex' && argv[i + 1]) out.senderRegex = argv[++i]
    else if (arg === '--sender-regex-flags' && argv[i + 1]) out.senderRegexFlags = argv[++i]
    else if (arg === '--exclude-sender-regex' && argv[i + 1]) out.excludeSenderRegex = argv[++i]
    else if (arg === '--exclude-sender-regex-flags' && argv[i + 1]) out.excludeSenderRegexFlags = argv[++i]
    else if (arg === '--exclude-text-regex' && argv[i + 1]) out.excludeTextRegex = argv[++i]
    else if (arg === '--exclude-text-regex-flags' && argv[i + 1]) out.excludeTextRegexFlags = argv[++i]
    else if (arg === '--link-text-regex' && argv[i + 1]) out.linkTextRegex = argv[++i]
    else if (arg === '--link-text-regex-flags' && argv[i + 1]) out.linkTextRegexFlags = argv[++i]
    else if (arg === '--link-href-regex' && argv[i + 1]) out.linkHrefRegex = argv[++i]
    else if (arg === '--link-href-regex-flags' && argv[i + 1]) out.linkHrefRegexFlags = argv[++i]
    else if (arg === '--max-links' && argv[i + 1]) out.maxLinks = argv[++i]
    else if (arg === '--max-text-chars' && argv[i + 1]) out.maxTextChars = argv[++i]
    else if (arg === '--max-messages' && argv[i + 1]) out.maxMessages = argv[++i]
    else if (arg === '--retries' && argv[i + 1]) out.retries = argv[++i]
    else if (arg === '--retry-delay-ms' && argv[i + 1]) out.retryDelayMs = argv[++i]
    else if (arg === '--check') out.check = true
    else if (arg === '--status-timeout-ms' && argv[i + 1]) out.statusTimeoutMs = argv[++i]
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

function parseOptionalTabId(value, label = 'tab-id') {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${String(value)} (must be positive integer)`)
  }
  return parsed
}

function parseRegexOption(label, pattern, flags) {
  if (!pattern) return null
  const safeFlags = typeof flags === 'string' ? flags : ''
  try {
    new RegExp(pattern, safeFlags)
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { pattern, flags: safeFlags }
}

function parseScreenshotFormat(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 'png'
  if (normalized === 'jpg') return 'jpeg'
  if (normalized === 'png' || normalized === 'jpeg' || normalized === 'webp') return normalized
  throw new Error(`Invalid screenshot-format: ${String(value)} (must be png|jpeg|webp)`)
}

function inferScreenshotFormatFromPath(filePath) {
  if (!filePath) return null
  const ext = path.extname(String(filePath)).trim().toLowerCase()
  if (ext === '.png') return 'png'
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg'
  if (ext === '.webp') return 'webp'
  return null
}

function resolveScreenshotFormat(explicitFormat, outputPath) {
  if (explicitFormat !== undefined) return parseScreenshotFormat(explicitFormat)
  const inferred = inferScreenshotFormatFromPath(outputPath)
  return inferred || 'png'
}

function parseScreenshotQuality(value, format) {
  if (value === undefined) return null
  if (format !== 'jpeg' && format !== 'webp') {
    throw new Error('screenshot-quality can only be used with screenshot-format jpeg or webp')
  }
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid screenshot-quality: ${String(value)} (must be 0-100)`)
  }
  return parsed
}

function buildBridgeExpression(config) {
  const normalizedPreset = String(config.preset || DEFAULT_PRESET).trim().toLowerCase()

  if (normalizedPreset === PRESET_WHATSAPP_MESSAGES || normalizedPreset === 'whatsapp' || normalizedPreset === 'wa') {
    return buildWhatsAppMessagesExpression(config)
  }

  if (normalizedPreset === PRESET_CHAT_AUDIT || normalizedPreset === 'chat') {
    return buildChatAuditExpression(config)
  }

  return defaultExpression(config)
}

function buildWhatsAppMessagesExpressionLegacy(config) {
  const safeConfig = {
    selector: String(config.selector || '#main [data-testid="conversation-panel-messages"], #main, .copyable-area'),
    messageRegex: config.messageRegex ? config.messageRegex.pattern : null,
    messageRegexFlags: config.messageRegex ? config.messageRegex.flags : null,
    messageExcludeRegex: config.excludeMessageRegex ? config.excludeMessageRegex.pattern : null,
    messageExcludeRegexFlags: config.excludeMessageRegex ? config.excludeMessageRegex.flags : null,
    senderRegex: config.senderRegex ? config.senderRegex.pattern : null,
    senderRegexFlags: config.senderRegex ? config.senderRegex.flags : null,
    senderExcludeRegex: config.excludeSenderRegex ? config.excludeSenderRegex.pattern : null,
    senderExcludeRegexFlags: config.excludeSenderRegex ? config.excludeSenderRegex.flags : null,
    maxMessages: Number.parseInt(String(config.maxMessages || DEFAULT_MESSAGE_MAX_MESSAGES), 10),
  }

  return `
(() => {
  const cfg = ${JSON.stringify(safeConfig)}

  const sanitize = (value) => (value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim())
  const escapeRegExp = (value) => String(value || '').replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')
  const normalizeFlags = (flags) => String(flags || '').replace(/g/gi, '')
  const compile = (pattern, flags) => {
    if (!pattern) return null
    return new RegExp(pattern, normalizeFlags(flags))
  }

  const matchText = (value, include, exclude) => {
    const text = sanitize(value)
    if (!text) return false
    if (exclude && exclude.test(text)) return false
    if (include) return include.test(text)
    return true
  }

  const messageSelectors = [
    '.message-in',
    '.message-out',
    '[data-testid^="msg-container"]',
    '[role="row"]',
    '[data-id]',
    '.focusable-list-item',
    '[data-testid="msg-container"]',
    '.copyable-text',
    '.copyable-text[data-pre-plain-text]',
    '[data-pre-plain-text]',
    '.message',
  ]
  const quoteSelectorsToRemove = ['[aria-label="Quoted message"]', '[data-testid="quoted-message"]', '._aju3']

  const removeQuotedReplyNodes = (rootNode) => {
    if (!rootNode?.querySelectorAll) return
    for (const selector of quoteSelectorsToRemove) {
      rootNode.querySelectorAll(selector).forEach((node) => {
        node.remove()
      })
    }
  }

  const getMessageText = (copyableTextElement) => {
    if (!(copyableTextElement instanceof Element)) return ''
    const clone = copyableTextElement.cloneNode(true)
    if (!(clone instanceof HTMLElement)) return ''

    removeQuotedReplyNodes(clone)

    let messageText = String(clone.textContent || '')
    const timeNode = copyableTextElement.querySelector('span > span.x3nfvp2') || copyableTextElement.querySelector('span.x3nfvp2')
    if (timeNode) {
      const timeText = sanitize(timeNode.textContent || '')
      if (timeText && new RegExp(escapeRegExp(timeText) + '$').test(sanitize(messageText))) {
        messageText = messageText.slice(0, messageText.length - timeText.length)
      }
    }

    if (!messageText.trim()) {
      const prePlain = String(copyableTextElement.getAttribute('data-pre-plain-text') || '')
      messageText = prePlain.replace(/^\\[[^\\]]+\\]\\s*[^:]+:\\s*/, '')
    }

    return sanitize(messageText)
  }

  const getCopyableTextElement = (candidate) => {
    if (!candidate?.querySelector) return null
    if (candidate.matches?.('.copyable-text[data-pre-plain-text]')) return candidate
    if (candidate.hasAttribute?.('data-pre-plain-text') && candidate.getAttribute('data-pre-plain-text')) return candidate
    return candidate.querySelector('.copyable-text[data-pre-plain-text]') || candidate.querySelector('[data-pre-plain-text]')
  }

  const parsePrePlain = (prePlainText) => {
    const prePlain = sanitize(prePlainText)
    if (!prePlain || prePlain[0] !== '[') return null

    const closeBracket = prePlain.indexOf(']')
    if (closeBracket <= 1) return null

    const header = prePlain.slice(1, closeBracket).trim()
    const headerParts = header.split(',')
    if (headerParts.length < 2) return null

    const rawTime = sanitize(headerParts[0])
    const rawDate = sanitize(header.slice(header.indexOf(',') + 1))
    const dateMatch = rawDate.match(/(\\d{1,2})[\\/.-](\\d{1,2})[\\/.-](\\d{2,4})/)
    if (!rawTime || !dateMatch || !dateMatch[1] || !dateMatch[2] || !dateMatch[3]) {
      return null
    }

    const normalizedTime = rawTime.replace(/\\s*[APMapm]{2}$/, '')
    const timeParts = normalizedTime.split(':')
    if (timeParts.length < 2) return null
    const hour = sanitize(timeParts[0]).padStart(2, '0')
    const minute = sanitize(timeParts[1]).padStart(2, '0')
    const time = hour + ':' + minute

    const month = sanitize(dateMatch[1]).padStart(2, '0')
    const day = sanitize(dateMatch[2]).padStart(2, '0')
    const yearRaw = sanitize(dateMatch[3])
    const year = yearRaw.length === 2 ? '20' + yearRaw : yearRaw

    const senderSection = prePlain.slice(closeBracket + 1).trim()
    if (!senderSection) return null
    const senderMatch = senderSection.match(/^([^:]+):/)
    if (!senderMatch || !senderMatch[1]) return null
    const sender = sanitize(senderMatch[1])

    return {
      time,
      sender,
      timestamp: [year, '-', month, '-', day, ' ', time, ':00'].join(''),
    }
  }

  const root = cfg.selector ? (document.querySelector(cfg.selector) || document.querySelector('#main') || document.body) : document.body

  const messageInclude = compile(cfg.messageRegex, cfg.messageRegexFlags)
  const messageExclude = compile(cfg.messageExcludeRegex, cfg.messageExcludeRegexFlags)
  const senderInclude = compile(cfg.senderRegex, cfg.senderRegexFlags)
  const senderExclude = compile(cfg.senderExcludeRegex, cfg.senderExcludeRegexFlags)

  const maxMessages = Number.isFinite(cfg.maxMessages) && cfg.maxMessages > 0 ? cfg.maxMessages : ${DEFAULT_MESSAGE_MAX_MESSAGES}

  const rawMessageElements = new Set()
  for (const selector of messageSelectors) {
    const directCandidates = root && root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : []
    if (directCandidates.length > 0) {
      directCandidates.forEach((node) => rawMessageElements.add(node))
    } else {
      Array.from(document.querySelectorAll(selector)).forEach((node) => rawMessageElements.add(node))
    }
  }

  const messages = []
  const seen = new Set()
  const seenCopyable = new Set()

  for (const candidate of rawMessageElements) {
    if (!candidate?.querySelector) continue

    try {
      const copyableTextElement = getCopyableTextElement(candidate)
      if (!copyableTextElement) continue
      if (seenCopyable.has(copyableTextElement)) continue
      seenCopyable.add(copyableTextElement)

      const fullMessage = getMessageText(copyableTextElement).trim()
      if (!fullMessage) continue
      const parsedPrePlain = parsePrePlain(copyableTextElement.getAttribute('data-pre-plain-text')) || {
        time: null,
        sender: '',
        timestamp: null,
      }

      const sender = parsedPrePlain.sender || ''

      if (sender && !matchText(sender, senderInclude, senderExclude)) continue
      if (!matchText(fullMessage, messageInclude, messageExclude)) continue
      if (!sender && senderInclude) continue

      const messageId =
        candidate.getAttribute('data-id') ||
        candidate.getAttribute('data-testid') ||
        copyableTextElement.getAttribute('data-id') ||
        copyableTextElement.getAttribute('data-testid') ||
        candidate.getAttribute('data-pre-plain-text') ||
        copyableTextElement.getAttribute('data-pre-plain-text') ||
        (parsedPrePlain.timestamp || '') + '|' + sender + '|' + fullMessage

      if (seen.has(messageId)) continue
      seen.add(messageId)

      const isOutgoing = Boolean(candidate.closest('.message-out') || candidate.classList?.contains('message-out'))
      const isIncoming = Boolean(candidate.closest('.message-in') || candidate.classList?.contains('message-in'))

      messages.push({
        messageId,
        message: fullMessage,
        username: sender,
        date: parsedPrePlain.timestamp || null,
        time: parsedPrePlain.time || null,
        isOutgoing: isOutgoing || (!isOutgoing && !isIncoming ? undefined : false),
      })
    } catch {
      continue
    }

    if (maxMessages > 0 && messages.length >= maxMessages) break
  }

  return {
    platform: 'whatsapp-web',
    selector: cfg.selector,
    count: messages.length,
    messages,
    filters: {
      messageRegex: cfg.messageRegex,
      messageRegexFlags: cfg.messageRegexFlags || null,
      messageExcludeRegex: cfg.messageExcludeRegex,
      messageExcludeRegexFlags: cfg.messageExcludeRegexFlags || null,
      senderRegex: cfg.senderRegex,
      senderRegexFlags: cfg.senderRegexFlags || null,
      senderExcludeRegex: cfg.senderExcludeRegex,
      senderExcludeRegexFlags: cfg.senderExcludeRegexFlags || null,
      maxMessages: cfg.maxMessages,
    },
  }
})()
`
}

function buildWhatsAppMessagesExpression(config) {
  const safeConfig = {
    selector: String(config.selector || '#main [data-testid="conversation-panel-messages"], #main, .copyable-area'),
    messageRegex: config.messageRegex ? config.messageRegex.pattern : null,
    messageRegexFlags: config.messageRegex ? config.messageRegex.flags : null,
    messageExcludeRegex: config.excludeMessageRegex ? config.excludeMessageRegex.pattern : null,
    messageExcludeRegexFlags: config.excludeMessageRegex ? config.excludeMessageRegex.flags : null,
    senderRegex: config.senderRegex ? config.senderRegex.pattern : null,
    senderRegexFlags: config.senderRegex ? config.senderRegex.flags : null,
    senderExcludeRegex: config.excludeSenderRegex ? config.excludeSenderRegex.pattern : null,
    senderExcludeRegexFlags: config.excludeSenderRegex ? config.excludeSenderRegex.flags : null,
    maxMessages: Number.parseInt(String(config.maxMessages || DEFAULT_MESSAGE_MAX_MESSAGES), 10),
  }

  return `
(() => {
  const cfg = ${JSON.stringify(safeConfig)}

  const MESSAGE_ROOT_SELECTOR =
    '.message-in, .message-out, [data-testid^="msg-container"], [role="row"], [data-id], .focusable-list-item'
  const QUOTED_MESSAGE_SELECTORS = ['[aria-label="Quoted message"]', '[data-testid="quoted-message"]', '._aju3']
  const QUOTE_AUTHOR_SELECTORS = ['span._ahxt', 'span[dir="auto"]._ahxt', '[data-testid="quoted-author"]']
  const QUOTE_TEXT_SELECTORS = ['.quoted-mention', '[data-testid="quoted-text"]', '[data-testid="selectable-text"]']

  const escapeReplyText = (value) => {
    const text = String(value || '')
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  const normalizeFlags = (flags) => String(flags || '').replace(/g/gi, '')
  const compile = (pattern, flags) => {
    if (!pattern) return null
    return new RegExp(pattern, normalizeFlags(flags))
  }

  const matchText = (value, include, exclude) => {
    const text = String(value || '').trim()
    if (!text) return false
    if (exclude && exclude.test(text)) return false
    if (include) return include.test(text)
    return true
  }

  const messageSelectors = [
    '.message-in',
    '.message-out',
    '[data-testid^="msg-container"]',
    '[role="row"]',
    '[data-id]',
    '.focusable-list-item',
    '.message',
    '.copyable-text',
    '.copyable-text[data-pre-plain-text]',
    '[data-pre-plain-text]',
    '[data-testid="msg-container"]',
  ]

  const removeQuotedReplyNodes = (rootNode) => {
    if (!rootNode?.querySelectorAll) return
    for (const selector of QUOTED_MESSAGE_SELECTORS) {
      rootNode.querySelectorAll(selector).forEach((node) => node.remove())
    }
  }

  const extractQuotedReply = (copyableTextElement) => {
    let quoteRoot = null
    for (const selector of QUOTED_MESSAGE_SELECTORS) {
      const candidate = copyableTextElement.querySelector(selector)
      if (candidate) {
        quoteRoot = candidate
        break
      }
    }
    if (!quoteRoot) return null

    let author = ''
    for (const selector of QUOTE_AUTHOR_SELECTORS) {
      const authorNode = quoteRoot.querySelector(selector)
      if (authorNode?.textContent) {
        author = String(authorNode.textContent).trim()
        break
      }
    }

    let text = ''
    for (const selector of QUOTE_TEXT_SELECTORS) {
      const node = quoteRoot.querySelector(selector)
      const candidateText = node?.textContent?.trim()
      if (candidateText) {
        text = candidateText
        break
      }
    }

    if (!text) {
      const clone = quoteRoot.cloneNode(true)
      if (!(clone instanceof Element)) return { author: author || undefined, text: undefined }
      removeQuotedReplyNodes(clone)
      const fallbackText = String(clone.textContent || '').trim()
      text = fallbackText
    }

    if (!text) return null
    return {
      author: author || undefined,
      text,
    }
  }

  const getCopyableTextElement = (candidate) => {
    if (!candidate?.querySelector) return null
    if (candidate.matches?.('.copyable-text[data-pre-plain-text]')) return candidate
    if (candidate.matches?.('.copyable-text') && candidate.getAttribute('data-pre-plain-text')) return candidate
    const selfDataPlain = candidate.getAttribute?.('data-pre-plain-text')
    if (selfDataPlain) return candidate
    return (
      candidate.querySelector('.copyable-text[data-pre-plain-text]') ||
      candidate.querySelector('[data-pre-plain-text]') ||
      candidate.closest?.(MESSAGE_ROOT_SELECTOR)?.querySelector?.('.copyable-text[data-pre-plain-text]') ||
      null
    )
  }

  const extractMessageText = (copyableTextElement) => {
    if (!(copyableTextElement instanceof Element)) return ''
    const clone = copyableTextElement.cloneNode(true)
    if (!(clone instanceof HTMLElement)) return ''

    removeQuotedReplyNodes(clone)
    clone.querySelectorAll('span.x3nfvp2').forEach((node) => {
      node.remove()
    })

    let messageText = String(clone.textContent || '')
    const timeNode = copyableTextElement.querySelector('span > span.x3nfvp2') || copyableTextElement.querySelector('span.x3nfvp2')
    if (timeNode) {
      const timeText = String(timeNode.textContent || '')
      if (timeText && messageText.endsWith(timeText)) {
        messageText = messageText.slice(0, messageText.length - timeText.length)
      }
    }

    return messageText.trim()
  }

  const parsePrePlain = (prePlainText) => {
    const prePlain = String(prePlainText || '')
    if (!prePlain || prePlain[0] !== '[') return null

    const closeBracket = prePlain.indexOf(']')
    if (closeBracket <= 1) return null

    const header = prePlain.slice(1, closeBracket).trim()
    const headerParts = header.split(',')
    if (headerParts.length < 2) return null

    const rawTime = String(headerParts[0] || '').trim()
    const rawDate = String(header.slice(header.indexOf(',') + 1))
    const dateMatch = rawDate.match(/(\\d{1,2})[\\/.-](\\d{1,2})[\\/.-](\\d{2,4})/)
    if (!rawTime || !dateMatch || !dateMatch[1] || !dateMatch[2] || !dateMatch[3]) return null

    const normalizedTime = rawTime.replace(/\\s*[APMapm]{2}$/, '')
    const timeParts = normalizedTime.split(':')
    if (timeParts.length < 2) return null

    const hour = String(timeParts[0]).trim().padStart(2, '0')
    const minute = String(timeParts[1]).trim().padStart(2, '0')
    const time = hour + ':' + minute

    const month = String(dateMatch[1]).trim().padStart(2, '0')
    const day = String(dateMatch[2]).trim().padStart(2, '0')
    const yearRaw = String(dateMatch[3]).trim()
    const year = yearRaw.length === 2 ? '20' + yearRaw : yearRaw

    const senderSection = prePlain.slice(closeBracket + 1).trim()
    if (!senderSection) return null
    const senderMatch = senderSection.match(/^([^:]+):/)
    if (!senderMatch || !senderMatch[1]) return null
    const sender = String(senderMatch[1]).trim()

    return {
      time,
      sender,
      timestamp: [year, '-', month, '-', day, ' ', time, ':00'].join(''),
    }
  }

  const root = cfg.selector
    ? document.querySelector(cfg.selector) || document.querySelector('#main') || document.body
    : document.body

  const messageInclude = compile(cfg.messageRegex, cfg.messageRegexFlags)
  const messageExclude = compile(cfg.messageExcludeRegex, cfg.messageExcludeRegexFlags)
  const senderInclude = compile(cfg.senderRegex, cfg.senderRegexFlags)
  const senderExclude = compile(cfg.senderExcludeRegex, cfg.senderExcludeRegexFlags)
  const maxMessages = Number.isFinite(cfg.maxMessages) && cfg.maxMessages > 0 ? cfg.maxMessages : ${DEFAULT_MESSAGE_MAX_MESSAGES}

  const rawMessageElements = new Set()
  for (const selector of messageSelectors) {
    const directCandidates = root && root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : []
    const fallbackCandidates = document.querySelectorAll(selector)
    if (directCandidates.length > 0) {
      directCandidates.forEach((node) => rawMessageElements.add(node))
    } else if (fallbackCandidates?.length) {
      Array.from(fallbackCandidates).forEach((node) => rawMessageElements.add(node))
    }
  }

  const messages = []
  const seen = new Set()
  const seenCopyable = new Set()

  for (const candidate of rawMessageElements) {
    if (!candidate?.querySelector) continue

    try {
      const messageRoot = candidate.closest?.(MESSAGE_ROOT_SELECTOR) || candidate
      const copyableTextElement = getCopyableTextElement(messageRoot)
      if (!copyableTextElement) continue
      if (seenCopyable.has(copyableTextElement)) continue
      seenCopyable.add(copyableTextElement)

      const quoteInfo = extractQuotedReply(copyableTextElement)
      const plainMessage = extractMessageText(copyableTextElement)
      const trimmedBody = String(plainMessage || '').trim()
      if (!trimmedBody && !quoteInfo) continue

      const parsedPrePlain = parsePrePlain(copyableTextElement.getAttribute('data-pre-plain-text')) || {
        time: null,
        sender: '',
        timestamp: null,
      }

      let finalMessage = trimmedBody
      if (quoteInfo?.text) {
        const replyAuthor = escapeReplyText(quoteInfo.author || '')
        const quoted = escapeReplyText(quoteInfo.text)
        const replyBlock = replyAuthor
          ? '<reply author="' + replyAuthor + '">' + quoted + '</reply>'
          : '<reply>' + quoted + '</reply>'
        finalMessage = finalMessage ? replyBlock + '\\n' + finalMessage : replyBlock
      }

      const sender = parsedPrePlain.sender || ''
      if (sender && !matchText(sender, senderInclude, senderExclude)) continue
      if (!matchText(finalMessage, messageInclude, messageExclude)) continue
      if (!sender && senderInclude) continue

      const messageId =
        messageRoot.getAttribute('data-id') ||
        messageRoot.getAttribute('data-testid') ||
        copyableTextElement.getAttribute('data-id') ||
        copyableTextElement.getAttribute('data-testid') ||
        copyableTextElement.getAttribute('data-pre-plain-text') ||
        messageRoot.getAttribute('data-pre-plain-text') ||
        (parsedPrePlain.timestamp || '') + '|' + sender + '|' + finalMessage

      if (seen.has(messageId)) continue
      seen.add(messageId)

      const isOutgoing = Boolean(messageRoot.closest('.message-out') || messageRoot.classList?.contains('message-out'))
      const isIncoming = Boolean(messageRoot.closest('.message-in') || messageRoot.classList?.contains('message-in'))

      messages.push({
        messageId,
        message: finalMessage,
        username: sender,
        date: parsedPrePlain.timestamp || null,
        time: parsedPrePlain.time || null,
        isOutgoing: isOutgoing || (!isOutgoing && !isIncoming ? undefined : false),
      })
    } catch {
      continue
    }

    if (maxMessages > 0 && messages.length >= maxMessages) break
  }

  return {
    platform: 'whatsapp-web',
    selector: cfg.selector,
    count: messages.length,
    messages,
    filters: {
      messageRegex: cfg.messageRegex,
      messageRegexFlags: cfg.messageRegexFlags || null,
      messageExcludeRegex: cfg.messageExcludeRegex,
      messageExcludeRegexFlags: cfg.messageExcludeRegexFlags || null,
      senderRegex: cfg.senderRegex,
      senderRegexFlags: cfg.senderRegexFlags || null,
      senderExcludeRegex: cfg.senderExcludeRegex,
      senderExcludeRegexFlags: cfg.senderExcludeRegexFlags || null,
      maxMessages: cfg.maxMessages,
    },
  }
})()
`
}

function buildChatAuditExpression(config) {
  const safeConfig = {
    selector: String(config.selector || 'body'),
    messageRegex: config.messageRegex ? config.messageRegex.pattern : null,
    messageRegexFlags: config.messageRegex ? config.messageRegex.flags : null,
    messageExcludeRegex: config.excludeMessageRegex ? config.excludeMessageRegex.pattern : null,
    messageExcludeRegexFlags: config.excludeMessageRegex ? config.excludeMessageRegex.flags : null,
    senderRegex: config.senderRegex ? config.senderRegex.pattern : null,
    senderRegexFlags: config.senderRegex ? config.senderRegex.flags : null,
    senderExcludeRegex: config.excludeSenderRegex ? config.excludeSenderRegex.pattern : null,
    senderExcludeRegexFlags: config.excludeSenderRegex ? config.excludeSenderRegex.flags : null,
    textRegex: config.textRegex ? config.textRegex.pattern : null,
    textRegexFlags: config.textRegex ? config.textRegex.flags : null,
    excludeTextRegex: config.excludeTextRegex ? config.excludeTextRegex.pattern : null,
    excludeTextRegexFlags: config.excludeTextRegex ? config.excludeTextRegex.flags : null,
    maxMessages: Number.parseInt(String(config.maxMessages || DEFAULT_MESSAGE_MAX_MESSAGES), 10),
  }

  return `
(() => {
  const cfg = ${JSON.stringify(safeConfig)}

  const sanitize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
  const normalizeFlags = (flags) => String(flags || '').replace(/g/gi, '')

  const compile = (pattern, flags) => {
    if (!pattern) return null
    return new RegExp(pattern, normalizeFlags(flags))
  }

  const matchText = (value, include, exclude) => {
    const text = sanitize(value)
    if (!text) return false
    if (exclude && exclude.test(text)) return false
    if (include) return include.test(text)
    return true
  }

  const samplePath = (node) => {
    if (!(node instanceof Element)) return ''
    const classes = Array.from(node.classList || []).slice(0, 2).filter(Boolean).map((item) => String(item).trim())
    return [node.tagName ? node.tagName.toLowerCase() : 'node', classes.length ? '.' + classes.join('.') : '']
      .filter(Boolean)
      .join('')
  }

  const messageSelectors = [
    '[data-testid^=\"msg\"]',
    '[data-testid*=\"message\"]',
    '[data-testid=\"message-body\"]',
    '[data-id]',
    '[role=\"row\"]',
    '[role=\"listitem\"]',
    '[data-msgid]',
    '[class*=\"message\"]',
    '[class*=\"bubble\"]',
    '[class*=\"chat\"]',
  ]

  const root = cfg.selector ? (document.querySelector(cfg.selector) || document.body) : document.body
  const messageInclude = compile(cfg.messageRegex, cfg.messageRegexFlags)
  const messageExclude = compile(cfg.messageExcludeRegex, cfg.messageExcludeRegexFlags)
  const senderInclude = compile(cfg.senderRegex, cfg.senderRegexFlags)
  const senderExclude = compile(cfg.senderExcludeRegex, cfg.senderExcludeRegexFlags)
  const textInclude = compile(cfg.textRegex, cfg.textRegexFlags)
  const textExclude = compile(cfg.excludeTextRegex, cfg.excludeTextRegexFlags)

  const selectorAudit = []
  const candidateMap = new Map()
  const maxCandidates = 400

  for (const selector of messageSelectors) {
    const scoped = root && root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : []
    const nodes = scoped.length ? scoped : Array.from(document.querySelectorAll(selector))

    selectorAudit.push({
      selector,
      matched: nodes.length,
      sample: nodes
        .slice(0, 10)
        .map((node) => ({ path: samplePath(node), text: sanitize(node.textContent).slice(0, 160) })),
    })

    for (const node of nodes) {
      if (!(node instanceof Element)) continue
      if (!candidateMap.has(node)) {
        candidateMap.set(node, selector)
      }
      if (candidateMap.size >= maxCandidates) break
    }
    if (candidateMap.size >= maxCandidates) break
  }

  const extractSender = (node) => {
    const directAttrs = ['data-sender', 'data-from', 'data-username', 'data-user', 'data-name']
    for (const attr of directAttrs) {
      const value = node.getAttribute?.(attr)
      if (value && sanitize(value).length > 0 && sanitize(value).length < 120) {
        return sanitize(value)
      }
    }

    const senderNodes = node.querySelectorAll?.(
      '[class*=\"sender\"], [data-testid*=\"sender\"], [class*=\"author\"], [data-testid*=\"author\"]',
    )
    for (const senderNode of senderNodes || []) {
      const value = sanitize(senderNode?.textContent)
      if (value && value.length >= 2 && value.length < 120) return value
    }
    return ''
  }

  const directionFromClass = (node) => {
    const classes = sanitize(node.className).toLowerCase()
    if (classes.includes('out') || classes.includes('sent') || classes.includes('right')) return 'outgoing'
    if (classes.includes('in') || classes.includes('incoming') || classes.includes('left')) return 'incoming'
    return 'unknown'
  }

  const extractText = (node) => {
    const clone = node.cloneNode(true)
    clone.querySelectorAll('script, style, noscript, button, input').forEach((el) => el.remove())
    return sanitize(clone.textContent || '')
  }

  const maxMessages = Number.isFinite(cfg.maxMessages) && cfg.maxMessages > 0 ? cfg.maxMessages : ${DEFAULT_MESSAGE_MAX_MESSAGES}
  const messages = []
  const seen = new Set()
  let matchedBySelector = 0
  let filteredByText = 0
  let filteredByMessage = 0
  let filteredBySender = 0

  for (const [node, selector] of candidateMap) {
    const fullText = extractText(node)
    if (!fullText) continue
    matchedBySelector += 1

    if (!matchText(fullText, textInclude, textExclude)) {
      filteredByText += 1
      continue
    }
    if (!matchText(fullText, messageInclude, messageExclude)) {
      filteredByMessage += 1
      continue
    }

    const sender = extractSender(node)
    if (!matchText(sender, senderInclude, senderExclude)) {
      filteredBySender += 1
      continue
    }

    const key = sender + '|' + fullText.slice(0, 240)
    if (seen.has(key)) continue
    seen.add(key)

    messages.push({
      selector,
      sender,
      direction: directionFromClass(node),
      text: fullText.slice(0, 9000),
      preview: fullText.slice(0, 120),
      path: samplePath(node),
    })

    if (messages.length >= maxMessages) break
  }

  return {
    platform: 'chat-audit',
    url: location.href,
    title: document.title,
    selector: cfg.selector,
    selectorAudit,
    totals: {
      selectorsChecked: selectorAudit.length,
      candidateNodes: candidateMap.size,
      matchedBySelector,
      filteredByText,
      filteredByMessage,
      filteredBySender,
      returned: messages.length,
    },
    filters: {
      messageRegex: cfg.messageRegex,
      messageRegexFlags: cfg.messageRegexFlags || null,
      messageExcludeRegex: cfg.messageExcludeRegex,
      messageExcludeRegexFlags: cfg.messageExcludeRegexFlags || null,
      senderRegex: cfg.senderRegex,
      senderRegexFlags: cfg.senderRegexFlags || null,
      senderExcludeRegex: cfg.senderExcludeRegex,
      senderExcludeRegexFlags: cfg.senderExcludeRegexFlags || null,
      textRegex: cfg.textRegex,
      textRegexFlags: cfg.textRegexFlags || null,
      excludeTextRegex: cfg.excludeTextRegex,
      excludeTextRegexFlags: cfg.excludeTextRegexFlags || null,
      maxMessages: cfg.maxMessages,
    },
    messages,
  }
})()
`
}

function defaultExpression(config) {
  const safeConfig = {
    selector: String(config.selector || 'body'),
    textRegex: config.textRegex ? config.textRegex.pattern : null,
    textRegexFlags: config.textRegex ? config.textRegex.flags : null,
    excludeTextRegex: config.excludeTextRegex ? config.excludeTextRegex.pattern : null,
    excludeTextRegexFlags: config.excludeTextRegex ? config.excludeTextRegex.flags : null,
    linkTextRegex: config.linkTextRegex ? config.linkTextRegex.pattern : null,
    linkTextRegexFlags: config.linkTextRegex ? config.linkTextRegex.flags : null,
    linkHrefRegex: config.linkHrefRegex ? config.linkHrefRegex.pattern : null,
    linkHrefRegexFlags: config.linkHrefRegex ? config.linkHrefRegex.flags : null,
    maxLinks: Number.parseInt(String(config.maxLinks || DEFAULT_MAX_LINKS), 10),
    maxTextChars: Number.parseInt(String(config.maxTextChars || DEFAULT_MAX_TEXT_CHARS), 10),
  }

  return `
(() => {
  const cfg = ${JSON.stringify(safeConfig)}

  const normalizeFlags = (flags) => String(flags || '').replace(/g/gi, '')
  const compile = (pattern, flags) => (pattern ? new RegExp(pattern, normalizeFlags(flags)) : null)
  const matchText = (value, include, exclude) => {
    const text = String(value || '').trim()
    if (!text) return false
    if (exclude) {
      const m = new RegExp(exclude.source, exclude.flags)
      if (m.test(text)) return false
    }
    if (include) {
      const m = new RegExp(include.source, include.flags)
      return m.test(text)
    }
    return true
  }

  const root = cfg.selector ? (document.querySelector(cfg.selector) || document.documentElement) : document.documentElement
  const textInclude = compile(cfg.textRegex, cfg.textRegexFlags)
  const textExclude = compile(cfg.excludeTextRegex, cfg.excludeTextRegexFlags)
  const linkTextInclude = compile(cfg.linkTextRegex, cfg.linkTextRegexFlags)
  const linkHrefInclude = compile(cfg.linkHrefRegex, cfg.linkHrefRegexFlags)

  const rawText = String((root && root.innerText) || '').trim()
  const lines = rawText
    .split(/\\r?\\n/)
    .map((item) => String(item || '').trim())
    .filter((item) => item)

  const text = lines
    .filter((line) => matchText(line, textInclude, textExclude))
    .join('\\n')
    .slice(0, Number.isFinite(cfg.maxTextChars) ? cfg.maxTextChars : 8000)

  const links = Array.from(root.querySelectorAll ? root.querySelectorAll('a[href]') : [])
    .map((a) => {
      return {
        text: String((a.textContent || '').trim()).replace(/\\s+/g, ' ').slice(0, 200),
        href: String(a.href || ''),
      }
    })
    .filter((item) => matchText(item.text, linkTextInclude, null))
    .filter((item) => {
      if (!linkHrefInclude) return true
      const m = new RegExp(linkHrefInclude.source, linkHrefInclude.flags)
      return m.test(item.href || '')
    })
    .slice(0, Number.isFinite(cfg.maxLinks) ? cfg.maxLinks : 20)

  return {
    url: location.href,
    title: document.title,
    metaDescription: (document.querySelector(\"meta[name='description']\")?.content || null),
    text,
    links,
    filters: {
      selector: cfg.selector,
      textRegex: cfg.textRegex,
      textRegexFlags: cfg.textRegexFlags || null,
      excludeTextRegex: cfg.excludeTextRegex,
      excludeTextRegexFlags: cfg.excludeTextRegexFlags || null,
      linkTextRegex: cfg.linkTextRegex,
      linkTextRegexFlags: cfg.linkTextRegexFlags || null,
      linkHrefRegex: cfg.linkHrefRegex,
      linkHrefRegexFlags: cfg.linkHrefRegexFlags || null,
      maxLinks: cfg.maxLinks,
      maxTextChars: cfg.maxTextChars,
    },
  }
})()
`
}

function sendRelayRequest(method, params, timeout = timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!activeSocket) {
      reject(new Error('Relay socket not open'))
      return
    }
    const id = nextId + 1
    nextId = id
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}`))
    }, timeout)

    pending.set(id, { resolve, reject, timer })
    socket.send(
      JSON.stringify({
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    )
  })
}

function sendRelayCommand(method, params, timeout = timeoutMs) {
  const relayParams = {
    method,
    ...(params !== undefined ? { params } : {}),
  }
  if (relaySessionId) {
    relayParams.relaySessionId = relaySessionId
  }
  if (Number.isInteger(leasedTabId)) {
    relayParams.tabId = leasedTabId
  }
  return sendRelayRequest('forwardCDPCommand', relayParams, timeout)
}

async function ensureRelaySession() {
  if (relaySessionId) return relaySessionId
  const openResult = await sendRelayRequest('Grais.relay.openSession', {
    client: 'read-active-tab',
    ...(Number.isInteger(requestedTabId) ? { tabId: requestedTabId } : {}),
  })
  if (!openResult || openResult.ok === false || typeof openResult.sessionId !== 'string') {
    throw new Error(openResult?.error || 'Failed to open relay session')
  }
  relaySessionId = openResult.sessionId
  if (Number.isInteger(openResult.tabId)) {
    leasedTabId = openResult.tabId
  }
  return relaySessionId
}

async function ensureRelayTabLease(tabId) {
  const requested = parseOptionalTabId(tabId, 'tab-id')
  if (!requested) return null
  await ensureRelaySession()
  const claimResult = await sendRelayRequest('Grais.relay.claimTab', {
    sessionId: relaySessionId,
    tabId: requested,
  })
  if (!claimResult || claimResult.ok === false) {
    throw new Error(claimResult?.error || `Failed to claim tab lease for tab ${requested}`)
  }
  leasedTabId = requested
  return requested
}

async function prepareTargetTabForCommand() {
  if (Number.isInteger(requestedTabId)) {
    await ensureRelayTabLease(requestedTabId)
    const attachResult = await sendRelayCommand('Grais.debugger.attachTab', { tabId: requestedTabId })
    if (attachResult && attachResult.ok === false) {
      throw new Error(attachResult.error || `Failed to attach tab ${requestedTabId}`)
    }
    return
  }
  try {
    await sendRelayCommand('Grais.debugger.ensureActiveTab')
  } catch {
    // Best effort for extension versions without this compatibility command.
  }
}

async function closeRelaySession() {
  if (!relaySessionId) return
  try {
    await sendRelayRequest('Grais.relay.closeSession', {
      sessionId: relaySessionId,
    }).catch(() => null)
  } finally {
    relaySessionId = null
  }
}

function sendRelayPing(timeout = timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!activeSocket) {
      reject(new Error('Relay socket not open'))
      return
    }

    const waiter = { resolve, reject, timer: null }
    waiter.timer = setTimeout(() => {
      const index = pendingPongs.indexOf(waiter)
      if (index >= 0) pendingPongs.splice(index, 1)
      reject(new Error('Relay ping timed out'))
    }, timeout)

    pendingPongs.push(waiter)
    try {
      socket.send(JSON.stringify({ method: 'ping' }))
    } catch (error) {
      clearTimeout(waiter.timer)
      const index = pendingPongs.indexOf(waiter)
      if (index >= 0) pendingPongs.splice(index, 1)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isRecoverableRelayError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase()
  if (!message) return false
  return (
    message.includes('relay has no active extension connection') ||
    message.includes('relay disconnected') ||
    message.includes('timed out waiting for runtime.evaluate') ||
    message.includes('timed out waiting for runtime.enable') ||
    message.includes('no response from relay bridge') ||
    message.includes('timed out') ||
    message.includes('relay timed out')
  )
}

function requestJson(url, timeoutMs = DEFAULT_STATUS_TIMEOUT_MS) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        protocol: 'http:',
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
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
            reject(new Error('Invalid JSON from relay status'))
          }
        })
      },
    )
    req.on('error', (error) => {
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    req.on('timeout', () => {
      req.destroy(new Error('Status request timeout'))
    })
  })
}

async function getRelayStatus(throwOnError = true) {
  try {
    const response = await requestJson(`${relayStatusUrl}?all=true`, statusTimeoutMs)
    relayStatusSnapshot = typeof response === 'object' && response ? response : null
    return { ok: true, ...(typeof response === 'object' && response ? response : {}) }
  } catch (error) {
    if (throwOnError) {
      throw error instanceof Error ? error : new Error(String(error))
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function parseStatusPort(value) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null
  return parsed
}

function sanitizeStatusTab(value) {
  if (!value || typeof value !== 'object') return null
  return {
    tabId: Number.isInteger(value.tabId) ? value.tabId : null,
    url: typeof value.url === 'string' ? value.url : null,
    title: typeof value.title === 'string' ? value.title : null,
    windowId: Number.isInteger(value.windowId) ? value.windowId : null,
    leasedSessionId: typeof value.leasedSessionId === 'string' ? value.leasedSessionId : null,
    port: parseStatusPort(value.port),
    state: typeof value.state === 'string' ? value.state : null,
  }
}

function sanitizeStatusLease(value) {
  if (!value || typeof value !== 'object') return null
  return {
    tabId: Number.isInteger(value.tabId) ? value.tabId : null,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
  }
}

function summarizeRelayPorts(statusPayload) {
  const rawPorts = Array.isArray(statusPayload?.ports)
    ? statusPayload.ports
    : [
        {
          port: parseStatusPort(statusPayload?.port) || relayPort,
          extensionConnected: statusPayload?.extensionConnected,
          extensionLastSeenAgoMs: statusPayload?.extensionLastSeenAgoMs,
          queuedControllerCommands: statusPayload?.queuedControllerCommands,
          activeTab: statusPayload?.activeTab,
          attachedTabs: statusPayload?.attachedTabs,
          attachedLeaseCount: statusPayload?.attachedLeaseCount,
          leasedTabCount: statusPayload?.leasedTabCount,
          staleLeaseCount: statusPayload?.staleLeaseCount,
          tabLeases: statusPayload?.tabLeases,
          staleTabLeases: statusPayload?.staleTabLeases,
          allowTargetCreate: statusPayload?.allowTargetCreate,
        },
      ]

  const ports = []
  for (const raw of rawPorts) {
    const port = parseStatusPort(raw.port)
    if (!port) continue
    ports.push({
      port,
      extensionConnected: Boolean(raw.extensionConnected),
      extensionLastSeenAgoMs:
        Number.isFinite(Number(raw.extensionLastSeenAgoMs)) ? Number(raw.extensionLastSeenAgoMs) : null,
      queuedControllerCommands: Number.isFinite(Number(raw.queuedControllerCommands))
        ? Number(raw.queuedControllerCommands)
        : null,
      attachedLeaseCount: Number.isFinite(Number(raw.attachedLeaseCount))
        ? Number(raw.attachedLeaseCount)
        : null,
      leasedTabCount: Number.isFinite(Number(raw.leasedTabCount))
        ? Number(raw.leasedTabCount)
        : null,
      staleLeaseCount: Number.isFinite(Number(raw.staleLeaseCount))
        ? Number(raw.staleLeaseCount)
        : null,
      activeTab: sanitizeStatusTab(raw.activeTab),
      attachedTabs: Array.isArray(raw.attachedTabs) ? raw.attachedTabs.map(sanitizeStatusTab).filter(Boolean) : [],
      tabLeases: Array.isArray(raw.tabLeases) ? raw.tabLeases.map(sanitizeStatusLease).filter(Boolean) : [],
      staleTabLeases: Array.isArray(raw.staleTabLeases)
        ? raw.staleTabLeases.map(sanitizeStatusLease).filter(Boolean)
        : [],
      extensionVersion: typeof raw.extensionVersion === 'string' ? raw.extensionVersion : null,
      extensionName: typeof raw.extensionName === 'string' ? raw.extensionName : null,
      extensionCapabilities:
        raw.extensionCapabilities && typeof raw.extensionCapabilities === 'object' ? raw.extensionCapabilities : null,
      allowTargetCreate: typeof raw.allowTargetCreate === 'boolean' ? raw.allowTargetCreate : null,
    })
  }
  ports.sort((a, b) => a.port - b.port)
  const activePorts = ports.filter((entry) => entry.extensionConnected).map((entry) => entry.port)
  return { ports, activePorts }
}

function findRelayPortStatus(snapshot, port = relayPort) {
  return snapshot.ports.find((entry) => entry.port === port) || null
}

function findAttachedTabOnPort(portStatus, tabId) {
  if (!portStatus || !Number.isInteger(tabId)) return null
  return portStatus.attachedTabs.find((entry) => entry.tabId === tabId) || null
}

function findAttachedTabAcrossPorts(snapshot, tabId) {
  if (!snapshot || !Number.isInteger(tabId)) return []
  const matches = []
  for (const entry of snapshot.ports) {
    const tab = findAttachedTabOnPort(entry, tabId)
    if (!tab) continue
    matches.push({ port: entry.port, tab })
  }
  return matches
}

function describeStatusTab(tab) {
  if (!tab) return 'unknown tab'
  const parts = []
  if (tab.title) parts.push(tab.title)
  if (tab.url) parts.push(tab.url)
  if (parts.length === 0) return `tab ${tab.tabId || 'unknown'}`
  return parts.join(' ')
}

function formatAvailableTabIds(portStatus) {
  if (!portStatus || !Array.isArray(portStatus.attachedTabs) || portStatus.attachedTabs.length === 0) return null
  return portStatus.attachedTabs
    .map((entry) => entry.tabId)
    .filter(Number.isInteger)
    .sort((a, b) => a - b)
    .join(', ')
}

function formatLeasedTabIds(portStatus) {
  if (!portStatus || !Array.isArray(portStatus.attachedTabs) || portStatus.attachedTabs.length === 0) return null
  const leasedIds = portStatus.attachedTabs
    .filter((entry) => typeof entry.leasedSessionId === 'string' && entry.leasedSessionId.length > 0)
    .map((entry) => entry.tabId)
    .filter(Number.isInteger)
    .sort((a, b) => a - b)
  return leasedIds.length > 0 ? leasedIds.join(', ') : null
}

function formatAlternativeTabIds(portStatus, excludedTabId, options = {}) {
  if (!portStatus || !Array.isArray(portStatus.attachedTabs) || portStatus.attachedTabs.length === 0) return null
  const filtered = portStatus.attachedTabs
    .filter((entry) => entry.tabId !== excludedTabId)
    .filter((entry) => !options.excludeLeased || !entry.leasedSessionId)
    .map((entry) => entry.tabId)
    .filter(Number.isInteger)
    .sort((a, b) => a - b)
  return filtered.length > 0 ? filtered.join(', ') : null
}

function formatLeaseSummary(portStatus) {
  if (!portStatus || !Array.isArray(portStatus.tabLeases) || portStatus.tabLeases.length === 0) return null
  return portStatus.tabLeases
    .map((entry) => `${entry.tabId} (${entry.sessionId})`)
    .join(', ')
}

function createBlocker(code, summary, nextAction, options = {}) {
  return {
    code,
    summary,
    nextAction,
    retryable: options.retryable !== false,
    detail: options.detail || null,
  }
}

function formatBlockerMessage(blocker) {
  if (!blocker) return 'Relay readiness check failed.'
  return [blocker.summary, blocker.nextAction].filter(Boolean).join(' ')
}

function buildBlockedCheckResult(relay, extension, blocker) {
  extension.error = blocker.summary
  return {
    ok: false,
    blocker,
    relay,
    extension,
    source: getRelaySource(),
  }
}

function buildPortMismatchHint(snapshot) {
  const mismatchPorts = snapshot.activePorts.filter((port) => port !== relayPort)
  if (mismatchPorts.length === 0) return null

  const details = []
  for (const port of mismatchPorts) {
    const match = snapshot.ports.find((entry) => entry.port === port)
    const tab = match?.activeTab
    if (!tab) {
      details.push(`${port}:unknown-tab`)
      continue
    }
    const title = tab.title || 'untitled'
    const url = tab.url || 'unknown'
    details.push(`${port}: ${title} ${url}`)
  }

  return `Extension is attached on port(s): ${details.join('; ')}`
}

function assertNoPortMismatch(snapshot) {
  const mismatchHint = buildPortMismatchHint(snapshot)
  if (!mismatchHint) return
  throw new Error(
    `${mismatchHint}. This command is targeting ${relayPort}. Re-run using one of: ${snapshot.activePorts.join(', ')}.`,
  )
}

function buildExtensionConnectionBlocker(snapshot) {
  const mismatchHint = buildPortMismatchHint(snapshot)
  if (mismatchHint) {
    return createBlocker(
      'PORT_MISMATCH',
      `${mismatchHint}. This command is targeting relay port ${relayPort}.`,
      `Re-run this command with --port "${snapshot.activePorts[0]}", or re-attach the target tab to relay port ${relayPort}.`,
      { retryable: false },
    )
  }

  return createBlocker(
    'EXTENSION_NOT_CONNECTED',
    `Relay is reachable at ${relayStatusUrl}, but the Chrome extension is not connected on port ${relayPort}.`,
    'Open the Agent Browser Relay popup once so Chrome wakes the extension, then run `npm run extension:status -- --wait-for-connected --connected-timeout-ms 120000` and retry.',
  )
}

function buildRequestedTabBlocker(snapshot, tabId) {
  if (!Number.isInteger(tabId)) return null
  const targetStatus = findRelayPortStatus(snapshot, relayPort)
  const targetTab = findAttachedTabOnPort(targetStatus, tabId)
  if (targetTab) {
    if (targetTab.leasedSessionId && targetTab.leasedSessionId !== relaySessionId) {
      const otherUnleasedTabIds = formatAlternativeTabIds(targetStatus, tabId, { excludeLeased: true })
      const otherAttachedTabIds = formatAlternativeTabIds(targetStatus, tabId)
      const detail = [
        `Attached tab: ${describeStatusTab(targetTab)}.`,
        `Current lease owner: ${targetTab.leasedSessionId}.`,
        otherUnleasedTabIds
          ? `Other unleased attached tab ids on port ${relayPort}: ${otherUnleasedTabIds}.`
          : otherAttachedTabIds
            ? `Other attached tab ids on port ${relayPort} are currently leased or unavailable: ${otherAttachedTabIds}.`
            : `No other attached tabs are currently available on port ${relayPort}.`,
      ].join(' ')
      return createBlocker(
        'TAB_LEASED_BY_OTHER_SESSION',
        `Tab ${tabId} is already leased by session ${targetTab.leasedSessionId} on relay port ${relayPort}.`,
        `Wait for session ${targetTab.leasedSessionId} to release tab ${tabId}, or choose another attached tab from \`npm run relay:status -- --all --status-timeout-ms 3000\` and retry with that \`--tab-id\`.`,
        { retryable: false, detail },
      )
    }
    return null
  }

  const attachedElsewhere = findAttachedTabAcrossPorts(snapshot, tabId).find((entry) => entry.port !== relayPort)
  if (attachedElsewhere) {
    return createBlocker(
      'TAB_ATTACHED_ON_OTHER_PORT',
      `Tab ${tabId} is attached on relay port ${attachedElsewhere.port}, not ${relayPort}.`,
      `Re-run this command with --port "${attachedElsewhere.port}", or re-attach tab ${tabId} to relay port ${relayPort}.`,
      { retryable: false, detail: `Attached tab on relay port ${attachedElsewhere.port}: ${describeStatusTab(attachedElsewhere.tab)}.` },
    )
  }

  const availableTabIds = formatAvailableTabIds(targetStatus)
  const unleasedTabIds = formatAlternativeTabIds(targetStatus, null, { excludeLeased: true })
  const leasedTabIds = formatLeasedTabIds(targetStatus)
  const leaseSummary = formatLeaseSummary(targetStatus)
  const detail = [
    availableTabIds ? `Attached tab ids on port ${relayPort}: ${availableTabIds}.` : null,
    unleasedTabIds ? `Attached tab ids without an active lease: ${unleasedTabIds}.` : null,
    leasedTabIds ? `Attached tab ids currently leased by another session: ${leasedTabIds}.` : null,
    leaseSummary ? `Current lease owners on port ${relayPort}: ${leaseSummary}.` : null,
  ].filter(Boolean).join(' ') || null
  return createBlocker(
    'TAB_NOT_ATTACHED',
    `Tab ${tabId} is not attached on relay port ${relayPort}.`,
    `Focus tab ${tabId} in Chrome and attach it in the popup, or choose another attached tab from \`npm run relay:status -- --all --status-timeout-ms 3000\` before retrying.`,
    { detail },
  )
}

function mapCommandErrorToBlocker(error, snapshot, tabId) {
  const rawMessage = error instanceof Error ? error.message : String(error || 'Relay check failed')
  const message = rawMessage.toLowerCase()
  const requestedTabBlocker = Number.isInteger(tabId) && snapshot ? buildRequestedTabBlocker(snapshot, tabId) : null

  if (message.includes('relay status check failed') || message.includes('relay not reachable')) {
    return createBlocker(
      'RELAY_UNREACHABLE',
      `Relay is not reachable at ${relayStatusUrl}.`,
      `Start the relay on ${relayHost}:${relayPort}, then retry this command.`,
    )
  }

  if (requestedTabBlocker?.code === 'TAB_LEASED_BY_OTHER_SESSION') {
    return requestedTabBlocker
  }

  if (message.includes('already leased by session')) {
    return createBlocker(
      'TAB_LEASED_BY_OTHER_SESSION',
      rawMessage,
      'Inspect `npm run relay:status -- --all --status-timeout-ms 3000`, choose another attached tab, or wait for the active controller session to release this lease before retrying.',
      { retryable: false },
    )
  }

  if (requestedTabBlocker) return requestedTabBlocker

  if (message.includes('target.createtarget is disabled')) {
    return createBlocker(
      'TARGET_CREATE_DISABLED',
      rawMessage,
      'Enable "Allow agent to create new background tabs" in the extension popup, then retry.',
      { retryable: false },
    )
  }

  if (
    message.includes('no response from relay bridge') ||
    message.includes('no response from tab') ||
    message.includes('relay ping timed out')
  ) {
    return createBlocker(
      'BRIDGE_NO_RESPONSE',
      Number.isInteger(tabId)
        ? `Relay is connected, but tab ${tabId} is not responding through the bridge yet.`
        : 'Relay is connected, but the active tab is not responding through the bridge yet.',
      Number.isInteger(tabId)
        ? `Keep tab ${tabId} attached in the popup and retry once the tab finishes loading.`
        : 'Keep the target tab active and attached in the popup, then retry once the page finishes loading.',
    )
  }

  return createBlocker(
    'ATTACH_NOT_READY',
    rawMessage,
    Number.isInteger(tabId)
      ? `Verify that tab ${tabId} is attached in the popup and still present in \`npm run relay:status -- --all --status-timeout-ms 3000\`, then retry.`
      : 'Verify that the target tab is attached in the popup and retry.',
  )
}

async function assertRelayConnectionReady() {
  const status = await getRelayStatus(false)
  if (!status.ok) {
    throw new Error(
      formatBlockerMessage(
        createBlocker(
          'RELAY_UNREACHABLE',
          `Relay is not reachable at ${relayStatusUrl}.`,
          `Start the relay on ${relayHost}:${relayPort}, then retry this command.`,
        ),
      ),
    )
  }
  const snapshot = summarizeRelayPorts(status)
  const targetStatus = findRelayPortStatus(snapshot, relayPort)
  if (!targetStatus || !targetStatus.extensionConnected) {
    throw new Error(formatBlockerMessage(buildExtensionConnectionBlocker(snapshot)))
  }
  const requestedTabBlocker = buildRequestedTabBlocker(snapshot, requestedTabId)
  if (requestedTabBlocker) {
    throw new Error(formatBlockerMessage(requestedTabBlocker))
  }
}

async function evaluateWithRecovery() {
  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await prepareTargetTabForCommand()

      const pingResult = await sendRelayCommand('Runtime.evaluate', {
        expression: '1 + 1',
        returnByValue: true,
      })
      if (!pingResult) throw new Error('No response from relay bridge')

      return await sendRelayCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries || !isRecoverableRelayError(lastError)) {
        throw lastError
      }
      await sleep(retryDelayMs)
    }
  }
  throw lastError || new Error('Failed to evaluate after retries')
}

async function checkBridge() {
  const relay = {
    reachable: true,
    extensionConnected: false,
    ping: false,
    queueDepth: null,
    extensionLastSeenAgoMs: null,
    targetCreateAllowed: null,
  }
  const extension = {
    connected: false,
    error: null,
  }
  const allowTablessTargetCreateCheck = requireTargetCreate && !Number.isInteger(requestedTabId)
  let snapshot = null

  try {
    const status = await getRelayStatus(false)
    if (!status.ok) {
      relay.reachable = false
      return buildBlockedCheckResult(
        relay,
        extension,
        createBlocker(
          'RELAY_UNREACHABLE',
          `Relay is not reachable at ${relayStatusUrl}.`,
          `Start the relay on ${relayHost}:${relayPort}, then retry this check.`,
        ),
      )
    }
    snapshot = summarizeRelayPorts(status)
    const targetStatus = findRelayPortStatus(snapshot, relayPort)
    relay.extensionConnected = Boolean(targetStatus ? targetStatus.extensionConnected : status.extensionConnected)
    relay.extensionLastSeenAgoMs = targetStatus?.extensionLastSeenAgoMs ?? null
    relay.queueDepth = Number.isFinite(Number(targetStatus?.queuedControllerCommands))
      ? Number(targetStatus.queuedControllerCommands)
      : Number.isFinite(Number(status.queuedControllerCommands))
        ? Number(status.queuedControllerCommands)
        : null
    relay.targetCreateAllowed = typeof targetStatus?.allowTargetCreate === 'boolean'
      ? targetStatus.allowTargetCreate
      : null
    relay.activePorts = snapshot.activePorts
    relay.ports = snapshot.ports

    if (!relay.extensionConnected) {
      return buildBlockedCheckResult(relay, extension, buildExtensionConnectionBlocker(snapshot))
    }

    const requestedTabBlocker = buildRequestedTabBlocker(snapshot, requestedTabId)
    if (requestedTabBlocker) {
      return buildBlockedCheckResult(relay, extension, requestedTabBlocker)
    }

    await sendRelayPing(timeoutMs)
    relay.ping = true

    if (requireTargetCreate && relay.targetCreateAllowed !== true) {
      const blocker = relay.targetCreateAllowed === false
        ? createBlocker(
            'TARGET_CREATE_DISABLED',
            'Target.createTarget is disabled on this relay connection.',
            'Enable "Allow agent to create new background tabs" in the extension popup, then retry.',
            { retryable: false },
          )
        : createBlocker(
            'TARGET_CREATE_UNKNOWN',
            'Target.createTarget readiness is unknown from relay status.',
            'Refresh the extension popup once so the relay receives fresh capability state, then retry.',
          )
      return buildBlockedCheckResult(relay, extension, blocker)
    }

    if (allowTablessTargetCreateCheck) {
      extension.connected = true
      return {
        ok: true,
        blocker: null,
        relay,
        extension,
        source: getRelaySource(),
      }
    }

    try {
      if (Number.isInteger(requestedTabId)) {
        await ensureRelayTabLease(requestedTabId)
        const attachResult = await sendRelayCommand('Grais.debugger.attachTab', { tabId: requestedTabId })
        if (attachResult && attachResult.ok === false) {
          throw new Error(attachResult.error || `Tab ${requestedTabId} attachment is not ready`)
        }
      } else {
        const attachResult = await sendRelayCommand('Grais.debugger.ensureActiveTab')
        if (attachResult && attachResult.ok === false) {
          throw new Error(attachResult.error || 'Active tab attachment is not ready')
        }
      }

      const pingResult = await sendRelayCommand('Runtime.evaluate', {
        expression: '1 + 1',
        returnByValue: true,
      }).catch(() => null)

      if (!pingResult) {
        throw new Error(
          Number.isInteger(requestedTabId)
            ? `No response from tab ${requestedTabId} through relay bridge`
            : 'No response from relay bridge',
        )
      }
      extension.connected = true
    } catch (ensureError) {
      if (!Number.isInteger(requestedTabId)) {
        const pingResult = await sendRelayCommand('Runtime.evaluate', {
          expression: '1 + 1',
          returnByValue: true,
        }).catch(() => null)

        if (pingResult) {
          extension.connected = true
          return {
            ok: true,
            blocker: null,
            relay,
            extension,
            source: getRelaySource(),
          }
        }
      }

      return buildBlockedCheckResult(relay, extension, mapCommandErrorToBlocker(ensureError, snapshot, requestedTabId))
    }
  } catch (error) {
    return buildBlockedCheckResult(relay, extension, mapCommandErrorToBlocker(error, snapshot, requestedTabId))
  }

  return {
    ok: relay.ping && extension.connected,
    blocker: null,
    relay,
    extension,
    source: getRelaySource(),
  }
}

async function captureScreenshotWithRecovery(config) {
  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await prepareTargetTabForCommand()

      const pingResult = await sendRelayCommand('Runtime.evaluate', {
        expression: '1 + 1',
        returnByValue: true,
      })
      if (!pingResult) throw new Error('No response from relay bridge')

      const params = {
        format: config.format,
      }
      if (config.quality !== null) {
        params.quality = config.quality
      }

      if (config.fullPage) {
        const metrics = await sendRelayCommand('Page.getLayoutMetrics', undefined, config.timeoutMs)
        const contentSize = metrics?.cssContentSize || metrics?.contentSize
        const width = Number(contentSize?.width)
        const height = Number(contentSize?.height)
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
          params.captureBeyondViewport = true
          params.clip = { x: 0, y: 0, width, height, scale: 1 }
        }
      }

      const result = await sendRelayCommand('Page.captureScreenshot', params, config.timeoutMs)
      if (!result || typeof result.data !== 'string' || result.data.length === 0) {
        throw new Error('Screenshot capture returned no image data')
      }
      return result
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries || !isRecoverableRelayError(lastError)) {
        throw lastError
      }
      await sleep(retryDelayMs)
    }
  }

  throw lastError || new Error('Failed to capture screenshot after retries')
}

async function waitForAttachmentReady(options = {}) {
  const timeoutMs = parseNonNegativeInt(options.timeoutMs, DEFAULT_ATTACH_TIMEOUT_MS, 'attach-timeout-ms')
  const pollMs = parsePositiveInt(options.pollMs, DEFAULT_ATTACH_POLL_MS, 'attach-poll-ms')
  let lastFailure

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await checkBridge()
    if (status.ok) return
    if (status.blocker?.retryable === false) {
      const blockerError = new Error(formatBlockerMessage(status.blocker))
      blockerError.readinessState = status
      throw blockerError
    }
    lastFailure = status
    await sleep(pollMs)
  }

  const lastBlocker = lastFailure?.blocker
  const timeoutError = new Error([
    `Timed out waiting for relay readiness (${timeoutMs}ms) at ${relayStatusUrl}.`,
    lastBlocker
      ? formatBlockerMessage(lastBlocker)
      : 'Keep the target tab active in Chrome, open the Agent Browser Relay popup, and confirm the target tab is attached before retrying.',
    lastBlocker?.detail || '',
  ].filter(Boolean).join(' '))
  timeoutError.readinessState = lastFailure || null
  throw timeoutError
}

async function main() {
  try {
    installBundle = refreshInstallBundle((message) => {
      console.error(`[agent-browser-relay] ${message}`)
    })
  } catch {
    installBundle = {
      ok: false,
      path: null,
      pathKind: null,
      sourcePath: null,
      visiblePath: null,
      installedVersion: null,
      visibleVersion: null,
      sourceVersion: null,
      relayVersion: null,
      versionMismatch: false,
      updated: false,
      sourceMissing: false,
      copyFailed: true,
      visiblePathReady: false,
      visiblePathNeedsRefresh: false,
    }
  }

  const opened = await waitForSocket(4000)
  if (!opened) {
    console.error(`Failed to connect websocket ${wsUrl}`)
    process.exit(1)
  }

  await getRelayStatus(false)
    .then(() => {
      const extension = getRelaySource().extension
      if (!extension.versionMismatch) return
      if (extension.observedExtensionVersion) {
        console.error(
          `[agent-browser-relay] Observed extension ${extension.observedExtensionVersion} does not match expected ${extension.expectedExtensionVersion}.`,
        )
      } else {
        console.error(`[agent-browser-relay] Relay extension and relay package versions are out of sync.`)
      }
      console.error(`[agent-browser-relay] Download updated bundle from: ${PROJECT_RELEASES_URL}`)
    })
    .catch((error) => {
      if (installBundle.copyFailed) {
        console.error('[agent-browser-relay] Failed to refresh the optional visible extension folder for Chrome install.')
        if (installBundle.path) {
          console.error(`[agent-browser-relay] Load the primary extension path instead: ${installBundle.path}`)
        }
        console.error(
          `[agent-browser-relay] Verify write permissions for ${path.join(os.homedir(), 'agent-browser-relay')} and rerun \`npm run extension:install\` if you want the visible shortcut.`,
        )
      }
      if (error && !error.message.includes('ECONNREFUSED')) {
        console.error(`[agent-browser-relay] Relay status check failed: ${error.message}`)
      }
    })

  rejectAllPending = (error) => {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer)
      entry.reject(error)
      pending.delete(id)
    }
  }

  try {
    if (checkOnly && (metadataOnly || screenshotOnly)) {
      throw new Error('--check cannot be combined with --metadata or screenshot options')
    }
    if (metadataOnly && screenshotOnly) {
      throw new Error('--metadata cannot be combined with screenshot options')
    }

    if (checkOnly) {
      if (waitForAttach && attachTimeoutMs > 0 && !(requireTargetCreate && !Number.isInteger(requestedTabId))) {
        await waitForAttachmentReady({ timeoutMs: attachTimeoutMs, pollMs: attachPollMs })
      }
      const status = await checkBridge()
      const output = pretty ? JSON.stringify(status, null, 2) : JSON.stringify(status)
      process.stdout.write(`${output}\n`)
      if (!status.ok) process.exit(1)
      return
    }

    if (metadataOnly) {
      if (waitForAttach && attachTimeoutMs > 0) {
        await waitForAttachmentReady({ timeoutMs: attachTimeoutMs, pollMs: attachPollMs })
      }

      await assertRelayConnectionReady()
      await prepareTargetTabForCommand()

      const metadata = await sendRelayCommand('Grais.debugger.getActiveTabMetadata')
      if (!metadata || metadata.error) {
        throw new Error(metadata?.error || 'Failed to read active tab metadata')
      }

      const payload = {
        ok: true,
        source: getRelaySource(),
        metadata,
      }

      const output = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)
      process.stdout.write(`${output}\n`)
      return
    }

    if (screenshotOnly) {
      if (waitForAttach && attachTimeoutMs > 0) {
        await waitForAttachmentReady({ timeoutMs: attachTimeoutMs, pollMs: attachPollMs })
      }

      await assertRelayConnectionReady()

      const result = await captureScreenshotWithRecovery({
        format: screenshotFormat,
        quality: screenshotQuality,
        fullPage: screenshotFullPage,
        timeoutMs: screenshotTimeoutMs,
      })

      const encoded = String(result.data || '')
      const imageBuffer = Buffer.from(encoded, 'base64')
      let resolvedOutputPath = null
      if (screenshotOutputPath) {
        resolvedOutputPath = path.resolve(screenshotOutputPath)
        fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true })
        fs.writeFileSync(resolvedOutputPath, imageBuffer)
      }

      const payload = {
        ok: true,
        source: getRelaySource(),
        screenshot: {
          format: screenshotFormat,
          quality: screenshotQuality,
          fullPage: screenshotFullPage,
          bytes: imageBuffer.length,
          path: resolvedOutputPath,
          dataBase64: resolvedOutputPath ? null : encoded,
        },
      }

      const output = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)
      process.stdout.write(`${output}\n`)
      return
    }

    if (waitForAttach && attachTimeoutMs > 0) {
      await waitForAttachmentReady({ timeoutMs: attachTimeoutMs, pollMs: attachPollMs })
    }

    await assertRelayConnectionReady()

    const result = await evaluateWithRecovery()

    if (!result || !('result' in result)) {
      throw new Error('Unexpected response from relay')
    }

    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      const description =
        details?.exception?.description || details?.text || details?.exception?.value || JSON.stringify(details)
      throw new Error(`Page evaluation failed: ${description}`)
    }

    const payload = {
      ok: true,
      source: getRelaySource(),
      data: result.result?.value ?? null,
    }

    const output = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)
    process.stdout.write(`${output}\n`)
  } catch (error) {
    if (checkOnly && error && typeof error === 'object' && error.readinessState) {
      const failureState = {
        ...(error.readinessState || {}),
        ok: false,
        failure: {
          message: error instanceof Error ? error.message : String(error),
        },
      }
      const output = pretty ? JSON.stringify(failureState, null, 2) : JSON.stringify(failureState)
      process.stdout.write(`${output}\n`)
      process.exit(1)
      return
    }
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  } finally {
    await closeRelaySession().catch(() => {})
    socket.close()
  }
}

function waitForSocket(ms) {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      if (activeSocket) return resolve(true)
      if (Date.now() - start > ms) return resolve(false)
      setTimeout(poll, 50)
    }
    poll()
  })
}

function printUsage() {
  console.log(`Usage:
  node read-active-tab.js [--host 127.0.0.1] [--port 18793] [--selector "body"] [--preset "default|whatsapp|whatsapp-messages|wa|chat-audit|chat"]
    [--tab-id 123]
    [--wait-for-attach] [--attach-timeout-ms 120000] [--attach-poll-ms 500]
    [--require-target-create]
    [--status-timeout-ms 1200]
    [--metadata]
    [--screenshot] [--screenshot-path "./out/page.png"] [--screenshot-format "png|jpeg|webp"]
    [--screenshot-quality 80] [--screenshot-full-page] [--screenshot-timeout-ms 15000]
    [--text-regex "pattern"] [--text-regex-flags "i"] [--exclude-text-regex "pattern"] [--exclude-text-regex-flags "i"]
    [--message-regex "pattern"] [--message-regex-flags "i"] [--exclude-message-regex "pattern"] [--exclude-message-regex-flags "i"]
    [--sender-regex "pattern"] [--sender-regex-flags "i"] [--exclude-sender-regex "pattern"] [--exclude-sender-regex-flags "i"]
    [--link-text-regex "pattern"] [--link-href-regex "pattern"]
    [--max-links 20] [--max-text-chars 8000] [--max-messages 500]
    [--check]
    [--expression "<js>"] [--timeout 3000] [--pretty true|false]
    [--retries 2] [--retry-delay-ms 400]

  --check: performs relay + extension handshake check only and exits.
  --require-target-create: with --check, fails unless Target.createTarget is enabled in popup settings; can be used without --tab-id for first-tab creation workflows.
  --tab-id: binds this run to a specific Chrome tab id using a relay session lease.
  --metadata: fetches active tab URL/title metadata without forcing DOM attach.
  --screenshot: capture a screenshot via CDP Page.captureScreenshot.
  --screenshot-path: when set, writes the image file and returns its absolute path in JSON.
  --screenshot-full-page: captures full page using Page.getLayoutMetrics.

Regex controls apply to default and chat-audit extractors unless you pass --expression.

Defaults:
- textRegex / flags: none / ""
- selector: "body"
- preset: default
- max-links: ${DEFAULT_MAX_LINKS}
- max-text-chars: ${DEFAULT_MAX_TEXT_CHARS}
- max-messages (preset-specific): ${DEFAULT_MESSAGE_MAX_MESSAGES}

WhatsApp preset:
- preset=whatsapp or preset=whatsapp-messages enables WhatsApp message-focused extraction.
- Filters available: --message-regex, --exclude-message-regex, --sender-regex, --exclude-sender-regex.

Chat-audit preset:
- preset=chat-audit or preset=chat enables generic chat DOM selector/message audits across chat UIs.
- Useful to validate candidate selectors, sender/message regex, and extract message-shaped nodes for debugging targeting.
- Filters available: --text-regex, --exclude-text-regex, --message-regex, --exclude-message-regex, --sender-regex, --exclude-sender-regex.

Examples:
  node read-active-tab.js --text-regex "order|price" --max-text-chars 2000
  node read-active-tab.js --preset whatsapp-messages --message-regex "invoice|payment" --selector "#main"
  node read-active-tab.js --preset chat-audit --text-regex "hello|hey" --sender-regex "Mathias"
  node read-active-tab.js --link-text-regex "docs|help" --link-href-regex "grais"
  node read-active-tab.js --screenshot --screenshot-path "./tmp/page.png"
  node read-active-tab.js --screenshot --screenshot-full-page --screenshot-format jpeg --screenshot-quality 80 --screenshot-path "./tmp/page.jpg"
`)
}

void main()
