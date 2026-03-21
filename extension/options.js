const DEFAULT_PORT = 18793

function setStatus(kind, message) {
  const status = document.getElementById('status')
  const pill = document.getElementById('statusPill')
  if (!status || !pill) return

  status.textContent = message || ''
  pill.classList.remove('ok', 'error', 'warn')

  if (kind === 'ok') {
    pill.textContent = 'Healthy'
    pill.classList.add('ok')
    return
  }
  if (kind === 'error') {
    pill.textContent = 'Offline'
    pill.classList.add('error')
    return
  }

  pill.textContent = 'Checking'
  pill.classList.add('warn')
}

function setHeroField(id, value) {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = value
}

async function requestJson(url, timeoutMs = 1200) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', signal: ctrl.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function checkRelayStatus(port) {
  const url = `http://127.0.0.1:${port}/status?all=true`
  try {
    const payload = await requestJson(url, 1200)
    const ports = Array.isArray(payload?.ports) ? payload.ports : []
    const connectedPorts = ports.filter((entry) => entry?.extensionConnected === true).map((entry) => entry.port)
    const attachedTabCount = ports.reduce((total, entry) => total + Number(entry?.attachedTabCount || 0), 0)
    const attachedLeaseCount = ports.reduce((total, entry) => total + Number(entry?.attachedLeaseCount || 0), 0)
    const staleLeaseCount = ports.reduce((total, entry) => total + Number(entry?.staleLeaseCount || 0), 0)

    setHeroField(
      'heroLease',
      attachedLeaseCount > 0
        ? `${attachedLeaseCount} live lease${attachedLeaseCount === 1 ? '' : 's'} across ${attachedTabCount} attached tab${attachedTabCount === 1 ? '' : 's'}.`
        : `${attachedTabCount} attached tab${attachedTabCount === 1 ? '' : 's'}. No active lease.`,
    )
    setHeroField(
      'heroRoute',
      connectedPorts.length > 0
        ? `Relay ${connectedPorts.join(', ')} connected.`
        : `Relay ${port} reachable. No extension heartbeat yet.`,
    )

    if (payload.extensionConnected === true) {
      const staleSuffix = staleLeaseCount > 0
        ? ` ${staleLeaseCount} stale lease${staleLeaseCount === 1 ? '' : 's'}.`
        : ''
      setStatus(
        'ok',
        `${attachedTabCount} attached tab${attachedTabCount === 1 ? '' : 's'}. Relay reachable.${staleSuffix}`,
      )
      return
    }

    setStatus(
      'error',
      'Relay reachable. Open the popup once to wake the extension.',
    )
  } catch {
    setHeroField('heroRoute', `Relay ${port} offline.`)
    setHeroField('heroLease', 'No relay state.')
    setStatus('error', 'Relay not active.')
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const port = Number.parseInt(String(stored.relayPort || DEFAULT_PORT), 10)
  const safePort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT
  setStatus('warn', `Checking relay on http://127.0.0.1:${safePort}/status…`)
  await checkRelayStatus(safePort)
}

void load()
