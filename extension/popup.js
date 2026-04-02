const statusEl = document.getElementById('status')
const connectedListEl = document.getElementById('connectedList')
const connectionsMetaEl = document.getElementById('connectionsMeta')
const tabPortSelect = document.getElementById('tabPort')
const savePortButton = document.getElementById('savePort')
const clearPortButton = document.getElementById('clearPort')
const routingToggleButton = document.getElementById('routingToggle')
const routingBodyEl = document.getElementById('routingBody')
const attachButton = document.getElementById('attach')
const refreshButton = document.getElementById('refresh')
const openExtensionTabButton = document.getElementById('openExtensionTab')
const allowCreateTargetToggle = document.getElementById('allowCreateTarget')

function setStatus(message) {
  if (!statusEl) return
  statusEl.textContent = message || ''
}

function setRoutingExpanded(expanded) {
  if (!routingToggleButton || !routingBodyEl) return
  const next = expanded === true
  routingToggleButton.setAttribute('aria-expanded', next ? 'true' : 'false')
  routingBodyEl.hidden = !next
}

function truncateText(value, max = 48) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function compactUrlLabel(rawUrl) {
  const urlText = String(rawUrl || '').trim()
  if (!urlText) return ''
  try {
    const parsed = new URL(urlText)
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
    return truncateText(`${parsed.hostname}${path}`, 38)
  } catch {
    return truncateText(urlText, 38)
  }
}

function compactTabTitle(item) {
  const title = truncateText(item?.title, 44)
  if (title) return title
  const urlLabel = compactUrlLabel(item?.url)
  if (urlLabel) return urlLabel
  if (item?.tabId != null) return `Tab ${item.tabId}`
  return 'Unknown tab'
}

function compactTabMeta(item, defaultPort) {
  const parts = []
  if (Number.isInteger(item?.tabId)) parts.push(`Tab ${item.tabId}`)
  parts.push(`Relay ${Number.isInteger(item?.port) ? item.port : defaultPort}`)
  if (item?.leasedSessionId) {
    parts.push(`Leased by ${truncateText(item.leasedSessionId, 18)}`)
  }
  const urlLabel = compactUrlLabel(item?.url)
  if (urlLabel) parts.push(urlLabel)
  return parts.join(' • ')
}

async function copyToClipboard(value) {
  const text = String(value || '').trim()
  if (!text) throw new Error('Missing tab ID')
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!copied) throw new Error('Clipboard write failed')
}

async function onCopyTabId(tabId) {
  if (!Number.isInteger(tabId)) {
    setStatus('Invalid tab ID.')
    return
  }
  try {
    await copyToClipboard(String(tabId))
    setStatus(`Copied tab ID ${tabId}.`)
  } catch (err) {
    setStatus(err?.message || `Failed to copy tab ID ${tabId}.`)
  }
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response) throw new Error('No response from background')
  if (!response.ok) throw new Error(response.error || 'Request failed')
  return response
}

async function getCurrentActiveTabId() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (Number.isInteger(active?.id)) return active.id
  const [fallback] = await chrome.tabs.query({ active: true })
  return Number.isInteger(fallback?.id) ? fallback.id : null
}

function renderConnectedTabs(state) {
  if (!connectedListEl) return
  connectedListEl.textContent = ''

  const entries = Array.isArray(state.connectedTabs) ? state.connectedTabs : []
  if (connectionsMetaEl) {
    const leaseCount = Number.isFinite(Number(state.attachedLeaseCount)) ? Number(state.attachedLeaseCount) : 0
    const staleLeaseCount = Number.isFinite(Number(state.staleLeaseCount)) ? Number(state.staleLeaseCount) : 0
    const suffix = [
      leaseCount > 0 ? `${leaseCount} leased` : null,
      staleLeaseCount > 0 ? `${staleLeaseCount} stale` : null,
    ].filter(Boolean).join(' • ')
    connectionsMetaEl.textContent = suffix ? `${entries.length} attached • ${suffix}` : `${entries.length} attached`
  }

  if (!entries.length) {
    const li = document.createElement('li')
    li.className = 'emptyState'
    li.textContent = 'No attached tabs.'
    connectedListEl.appendChild(li)
    return
  }

  for (const item of entries) {
    const li = document.createElement('li')
    li.className = 'connectionCard'

    const top = document.createElement('div')
    top.className = 'connectionTop'

    const title = document.createElement('div')
    title.className = 'connectionTitle'
    title.textContent = compactTabTitle(item)
    top.appendChild(title)
    li.appendChild(top)

    const meta = document.createElement('div')
    meta.className = 'connectionMeta'

    const text = document.createElement('span')
    text.className = 'connectionInfo'
    text.textContent = compactTabMeta(item, state.defaultPort)
    meta.appendChild(text)

    if (Number.isInteger(item.tabId)) {
      const copyButton = document.createElement('button')
      copyButton.type = 'button'
      copyButton.className = 'copyTabId'
      copyButton.textContent = 'Copy ID'
      copyButton.setAttribute('aria-label', `Copy tab ID ${item.tabId}`)
      copyButton.addEventListener('click', () => {
        void onCopyTabId(item.tabId)
      })
      meta.appendChild(copyButton)
    }

    li.appendChild(meta)
    connectedListEl.appendChild(li)
  }
}

function renderAttachmentControl(state) {
  if (!attachButton || !tabPortSelect) return

  if (allowCreateTargetToggle) {
    allowCreateTargetToggle.checked = Boolean(state.allowTargetCreate)
  }

  const preferredPort = Number.isInteger(state.mappedPort)
    ? state.mappedPort
    : Number.isInteger(state.effectivePort)
      ? state.effectivePort
      : state.defaultPort
  const desired = Number.isInteger(preferredPort) ? String(preferredPort) : null

  if (desired && tabPortSelect.querySelector(`option[value="${desired}"]`)) {
    tabPortSelect.value = desired
  } else if (tabPortSelect.options[0]?.value) {
    tabPortSelect.value = tabPortSelect.options[0].value
  }

  const isCurrentAttached = state.userAttachmentEnabled && state.activeTabState === 'connected'
  attachButton.textContent = isCurrentAttached ? 'Detach this tab' : 'Attach this tab'
}

async function refresh() {
  try {
    const tabId = await getCurrentActiveTabId()
    const response = await sendMessage({ type: 'grais.popup.getState', tabId, includeAllTabs: true })
    renderAttachmentControl(response)
    renderConnectedTabs(response)

    if (response.relayConnectError) {
      setStatus(response.relayConnectError)
      return
    }
    if (Number.isInteger(response.relayPortConnected)) {
      setStatus(`Relay connected on ${response.relayPortConnected}.`)
      return
    }
    setStatus('Relay not connected.')
  } catch (err) {
    setStatus(err?.message || 'Failed to load state.')
  }
}

async function onSavePort() {
  try {
    const port = Number.parseInt(String(tabPortSelect?.value || ''), 10)
    const tabId = await getCurrentActiveTabId()
    if (!tabId) {
      setStatus('No active tab.')
      return
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      setStatus('Invalid port selection.')
      return
    }
    await sendMessage({ type: 'grais.popup.setTabPort', tabId, port })
    setStatus(`Saved route ${port}.`)
    await refresh()
  } catch (err) {
    setStatus(err?.message || 'Failed to save port.')
  }
}

async function onClearPort() {
  try {
    const tabId = await getCurrentActiveTabId()
    if (!tabId) {
      setStatus('No active tab.')
      return
    }
    await sendMessage({ type: 'grais.popup.clearTabPort', tabId })
    setStatus('Cleared route.')
    await refresh()
  } catch (err) {
    setStatus(err?.message || 'Failed to clear relay route.')
  }
}

async function onToggleAttach() {
  try {
    const tabId = await getCurrentActiveTabId()
    if (!tabId) {
      setStatus('No active tab.')
      return
    }
    const response = await sendMessage({ type: 'grais.popup.toggleTabAttachment', tabId })
    setStatus(response.attached ? 'Tab attached.' : 'Tab detached.')
    await refresh()
  } catch (err) {
    setStatus(err?.message || 'Failed to toggle attachment.')
  }
}

async function onToggleAllowCreateTarget() {
  if (!allowCreateTargetToggle) return
  const enabled = allowCreateTargetToggle.checked === true
  try {
    const tabId = await getCurrentActiveTabId()
    const response = await sendMessage({
      type: 'grais.popup.setTargetCreateEnabled',
      enabled,
      tabId,
    })
    renderAttachmentControl(response)
    renderConnectedTabs(response)
    setStatus('')
  } catch (err) {
    allowCreateTargetToggle.checked = !enabled
    setStatus(err?.message || 'Failed to update target-create setting.')
  }
}

async function onOpenExtensionTab() {
  try {
    await chrome.runtime.openOptionsPage()
    window.close()
  } catch (err) {
    setStatus(err?.message || 'Failed to open extension tab.')
  }
}

refreshButton?.addEventListener('click', () => void refresh())
savePortButton?.addEventListener('click', () => void onSavePort())
clearPortButton?.addEventListener('click', () => void onClearPort())
routingToggleButton?.addEventListener('click', () => {
  const expanded = routingToggleButton.getAttribute('aria-expanded') === 'true'
  setRoutingExpanded(!expanded)
})
openExtensionTabButton?.addEventListener('click', () => void onOpenExtensionTab())
attachButton?.addEventListener('click', () => void onToggleAttach())
allowCreateTargetToggle?.addEventListener('change', () => void onToggleAllowCreateTarget())

setRoutingExpanded(false)
void refresh()
