const DEFAULT_PORT = 18793

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function checkRelayReachable(port) {
  const url = `http://127.0.0.1:${port}/`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 900)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setStatus('ok', `Relay reachable at ${url}`)
  } catch {
    setStatus(
      'error',
      'Relay not active, tell your agent to start Agent Browser Relay.',
    )
  } finally {
    clearTimeout(t)
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const port = Number.parseInt(String(stored.relayPort || DEFAULT_PORT), 10)
  const safePort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT
  setStatus('ok', `Checking relay on http://127.0.0.1:${safePort}/`)
  await checkRelayReachable(safePort)
}

void load()
