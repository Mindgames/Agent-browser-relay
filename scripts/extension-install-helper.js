#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const SOURCE_EXTENSION_PATH = path.join(REPO_ROOT, 'extension')
const SOURCE_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json')

const VISIBLE_ROOT = path.join(os.homedir(), 'agent-browser-relay')
const VISIBLE_EXTENSION_PATH = path.join(VISIBLE_ROOT, 'extension')
const VISIBLE_STATE_PATH = path.join(VISIBLE_ROOT, 'extension-install-state.json')

const PROJECT_URL = 'https://github.com/Mindgames/agent-browser-relay'
const PROJECT_RELEASES_URL = 'https://github.com/Mindgames/agent-browser-relay/releases/latest'

const PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000

function readJson(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function readManifestVersion(directory) {
  const manifest = readJson(path.join(directory, 'manifest.json'), null)
  const version = typeof manifest?.version === 'string' ? manifest.version.trim() : ''
  return version.length ? version : null
}

function readPackageVersion() {
  const pkg = readJson(SOURCE_PACKAGE_PATH, null)
  const version = typeof pkg?.version === 'string' ? pkg.version.trim() : ''
  return version.length ? version : null
}

function readInstallState() {
  return readJson(VISIBLE_STATE_PATH, {})
}

function writeInstallState(state) {
  try {
    fs.mkdirSync(VISIBLE_ROOT, { recursive: true })
    fs.writeFileSync(VISIBLE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // best effort only
  }
}

function refreshVisiblePackageManifest() {
  try {
    const packageContent = fs.readFileSync(SOURCE_PACKAGE_PATH, 'utf8')
    fs.rmSync(path.join(VISIBLE_EXTENSION_PATH, 'package.json'), { force: true })
    fs.writeFileSync(path.join(VISIBLE_EXTENSION_PATH, 'package.json'), packageContent, 'utf8')
    return
  } catch {
    // fallback: if source package cannot be read, keep destination as-is
  }
}

function refreshInstallBundle(log = () => {}) {
  const sourceVersion = readManifestVersion(SOURCE_EXTENSION_PATH)
  const relayVersion = readPackageVersion()
  const state = readInstallState()
  const now = Date.now()

  let installedVersion = readManifestVersion(VISIBLE_EXTENSION_PATH)
  let updated = false
  let copyFailed = false

  if (!sourceVersion) {
    return {
      ok: false,
      path: VISIBLE_EXTENSION_PATH,
      installedVersion,
      sourceVersion,
      relayVersion,
      updated,
      firstRun: false,
      versionMismatch: copyFailed,
      sourceMissing: true,
      copyFailed,
    }
  }

  if (!installedVersion || installedVersion !== sourceVersion) {
    try {
      fs.mkdirSync(VISIBLE_ROOT, { recursive: true })
      fs.rmSync(VISIBLE_EXTENSION_PATH, { recursive: true, force: true })
      fs.cpSync(SOURCE_EXTENSION_PATH, VISIBLE_EXTENSION_PATH, {
        recursive: true,
        dereference: true,
      })
      refreshVisiblePackageManifest()
      installedVersion = sourceVersion
      updated = true
    } catch {
      copyFailed = true
      return {
        ok: false,
        path: VISIBLE_EXTENSION_PATH,
        installedVersion,
        sourceVersion,
        relayVersion,
        updated,
        firstRun: false,
        versionMismatch: copyFailed,
        sourceMissing: false,
        copyFailed,
      }
    }
  }

  const installedMissing = Boolean(sourceVersion && !installedVersion)
  const installedMismatch = Boolean(sourceVersion && installedVersion && sourceVersion !== installedVersion)
  const relayMismatch = Boolean(relayVersion && installedVersion && relayVersion !== installedVersion)
  const mismatch = Boolean(installedMissing || installedMismatch || relayMismatch || copyFailed)

  const firstRun = state.firstRunSeen !== true
  const lastHintAt = Number.isFinite(Number(state.lastHintAt)) ? Number(state.lastHintAt) : 0
  const shouldPrintHint = mismatch || firstRun || (now - lastHintAt >= PROMPT_COOLDOWN_MS)

  if (shouldPrintHint) {
    if (firstRun) {
      log('[agent-browser-relay] First run setup for this machine:')
      log('1) Open Chrome and visit chrome://extensions')
      log('2) Enable Developer mode (top-right)')
      log('3) Click "Load unpacked"')
      log(`4) Select this folder:`)
      log(`   ${VISIBLE_EXTENSION_PATH}`)
      log('5) Pin Agent Browser Relay in the toolbar (optional but recommended)')
      log('')
    }

    log(`Chrome extension install path:`)
    log(`  ${VISIBLE_EXTENSION_PATH}`)
    log('Load this folder in chrome://extensions (Load unpacked).')
    log('If the extension was previously loaded from another folder, repoint it here.')
    log(`Extension version: ${installedVersion || 'unknown'}`)
    log(`Relay package version: ${relayVersion || 'unknown'}`)
    log(`Source manifest version: ${sourceVersion || 'unknown'}`)
    if (mismatch) {
      log('Version mismatch detected. Download newest extension bundle from:')
      log(`  ${PROJECT_URL}`)
      log(`Or update from releases:`)
      log(`  ${PROJECT_RELEASES_URL}`)
    }
  }

  writeInstallState({
    lastHintAt: now,
    firstRunSeen: true,
    lastCheckedAt: now,
    installedVersion,
    relayVersion,
    sourceVersion,
    mismatch: mismatch,
  })

  return {
    ok: true,
    path: VISIBLE_EXTENSION_PATH,
    installedVersion,
    sourceVersion,
    relayVersion,
    updated,
    firstRun,
    versionMismatch: mismatch,
    sourceMissing: false,
    copyFailed,
  }
}

function describeInstallBundleFailure(result) {
  const targetPath = result?.path || VISIBLE_EXTENSION_PATH
  if (result?.sourceMissing) {
    return `[agent-browser-relay] Failed to prepare visible extension folder at ${targetPath}: extension source is missing from ${SOURCE_EXTENSION_PATH}.`
  }
  if (result?.copyFailed) {
    return [
      `[agent-browser-relay] Failed to prepare visible extension folder at ${targetPath}: copy failed.`,
      `Check that ${VISIBLE_ROOT} is writable and retry.`,
    ].join(' ')
  }
  return `[agent-browser-relay] Failed to prepare visible extension folder at ${targetPath}.`
}

function runCli() {
  const result = refreshInstallBundle((message) => {
    console.error(`[agent-browser-relay] ${message}`)
  })

  if (result.ok) {
    return
  }

  console.error(describeInstallBundleFailure(result))
  process.exitCode = 1
}

if (require.main === module) {
  runCli()
}

module.exports = {
  describeInstallBundleFailure,
  refreshInstallBundle,
}
