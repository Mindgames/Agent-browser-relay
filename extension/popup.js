const stateRowEl = document.getElementById('stateRow')
const statusEl = document.getElementById('status')
const activeTabEl = document.getElementById('activeTab')
const defaultPortEl = document.getElementById('defaultPort')
const connectedPortEl = document.getElementById('connectedPort')
const connectedListEl = document.getElementById('connectedList')
const tabPortSelect = document.getElementById('tabPort')
const savePortButton = document.getElementById('savePort')
const clearPortButton = document.getElementById('clearPort')
const attachButton = document.getElementById('attach')
const refreshButton = document.getElementById('refresh')
const allowCreateTargetToggle = document.getElementById('allowCreateTarget')

function setStatus(message, kind = 'ok') {
  if (!statusEl) return
  statusEl.textContent = message
  statusEl.classList.remove('ok', 'err')
  statusEl.classList.add(kind)
}

function tabLabel(item) {
  const parts = []
  if (item.tabId != null) parts.push(`Tab ${item.tabId}`)
  if (item.title) parts.push(item.title)
  if (item.url) parts.push(item.url)
  return parts.join(' — ')
}

async function copyToClipboard(value) {
  const text = String(value || '').trim()
  if (!text) {
    throw new Error('Missing tab ID')
  }
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
  if (!copied) {
    throw new Error('Clipboard write failed')
  }
}

async function onCopyTabId(tabId) {
  if (!Number.isInteger(tabId)) {
    setStatus('Invalid tab ID', 'err')
    return
  }
  try {
    await copyToClipboard(String(tabId))
    setStatus(`Copied Tab ID ${tabId}`, 'ok')
  } catch (err) {
    setStatus(err?.message || `Failed to copy Tab ID ${tabId}`, 'err')
  }
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response) {
    throw new Error('No response from background')
  }
  if (!response.ok) {
    throw new Error(response.error || 'Request failed')
  }
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

  const entries = state.connectedTabs || []
  if (!entries.length) {
    connectedListEl.innerHTML = '<li>None</li>'
    return
  }

  for (const item of entries) {
    const li = document.createElement('li')
    const row = document.createElement('div')
    row.className = 'connectionRow'
    const text = document.createElement('span')
    text.className = 'connectionText'
    const connected = item.state === 'connected' ? 'connected' : item.state
    const override = Number.isInteger(item.port) ? `${item.port}` : `${state.defaultPort} (default)`
    const portText = `Relay ${override}`
    text.textContent = `${connected}: ${tabLabel(item)} (${portText})`
    row.appendChild(text)

    if (Number.isInteger(item.tabId)) {
      const copyButton = document.createElement('button')
      copyButton.type = 'button'
      copyButton.className = 'secondary copyTabId'
      copyButton.textContent = 'Copy ID'
      copyButton.setAttribute('aria-label', `Copy tab ID ${item.tabId}`)
      copyButton.addEventListener('click', () => {
        void onCopyTabId(item.tabId)
      })
      row.appendChild(copyButton)
    }

    li.appendChild(row)
    connectedListEl.appendChild(li)
  }
}

function renderAttachmentControl(state) {
  if (!attachButton || !activeTabEl || !stateRowEl || !defaultPortEl || !connectedPortEl || !tabPortSelect) return

  activeTabEl.textContent = state.activeTab ? tabLabel(state.activeTab) : `Current tab: ${state.requestedTabId || 'unknown'}`
  defaultPortEl.textContent = `default ${state.defaultPort}`
  connectedPortEl.textContent = `active relay ${state.relayPortConnected}`
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
  stateRowEl.textContent = isCurrentAttached
    ? 'Current tab is attached'
    : state.userAttachmentEnabled
      ? 'Current tab is not attached'
      : 'Attachment disabled'
}

async function refresh() {
  try {
    const tabId = await getCurrentActiveTabId()
    const response = await sendMessage({ type: 'grais.popup.getState', tabId, includeAllTabs: true })
    renderAttachmentControl(response)
    renderConnectedTabs(response)
    if (response.relayConnectError) {
      setStatus(response.relayConnectError, 'err')
      return
    }
    if (Number.isInteger(response.relayPortConnected)) {
      setStatus(`Relay connected on ${response.relayPortConnected}`, 'ok')
      return
    }
    setStatus('Extension loaded, but relay is not connected yet', 'err')
  } catch (err) {
    setStatus(err.message || 'Failed to load state', 'err')
  }
}

async function onSavePort() {
  try {
    const port = Number.parseInt(String(tabPortSelect?.value || ''), 10)
    const tabId = await getCurrentActiveTabId()
    if (!tabId) {
      setStatus('No active tab', 'err')
      return
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      setStatus('Invalid port selection', 'err')
      return
    }
    await sendMessage({ type: 'grais.popup.setTabPort', tabId, port })
    setStatus(`Saved tab port ${port}`, 'ok')
    await refresh()
  } catch (err) {
    setStatus(err.message || 'Failed to save', 'err')
  }
}

async function onClearPort() {
  try {
    const tabId = await getCurrentActiveTabId()
    if (!tabId) {
      setStatus('No active tab', 'err')
      return
    }
    await sendMessage({ type: 'grais.popup.clearTabPort', tabId })
    setStatus('Cleared tab override', 'ok')
    await refresh()
  } catch (err) {
    setStatus(err.message || 'Failed to clear', 'err')
  }
}

async function onToggleAttach() {
  try {
    const tabId = await getCurrentActiveTabId()
    if (!tabId) {
      setStatus('No active tab', 'err')
      return
    }
    const response = await sendMessage({ type: 'grais.popup.toggleTabAttachment', tabId })
    setStatus(response.attached ? 'Attached' : 'Detached', 'ok')
    await refresh()
  } catch (err) {
    setStatus(err.message || 'Failed to toggle', 'err')
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
    setStatus(
      response.allowTargetCreate ? 'Agent new-tab spawn enabled' : 'Agent new-tab spawn disabled',
      'ok',
    )
  } catch (err) {
    allowCreateTargetToggle.checked = !enabled
    setStatus(err.message || 'Failed to update setting', 'err')
  }
}

refreshButton?.addEventListener('click', () => void refresh())
savePortButton?.addEventListener('click', () => void onSavePort())
clearPortButton?.addEventListener('click', () => void onClearPort())
attachButton?.addEventListener('click', () => void onToggleAttach())
allowCreateTargetToggle?.addEventListener('change', () => void onToggleAllowCreateTarget())

void refresh()
