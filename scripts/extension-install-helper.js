#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const SOURCE_EXTENSION_PATH = path.join(REPO_ROOT, 'extension')
const SOURCE_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json')

const GLOBAL_SKILL_ROOT = path.join(os.homedir(), '.agents', 'skills', 'agent-browser-relay')
const GLOBAL_EXTENSION_PATH = path.join(GLOBAL_SKILL_ROOT, 'extension')
const PRIVATE_SKILL_ROOT = path.join(os.homedir(), '.agents', 'skills', 'private', 'agent-browser-relay')
const PRIVATE_EXTENSION_PATH = path.join(PRIVATE_SKILL_ROOT, 'extension')

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

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath)
  } catch {
    return null
  }
}

function refreshVisiblePackageManifest() {
  try {
    const packageContent = fs.readFileSync(SOURCE_PACKAGE_PATH, 'utf8')
    fs.rmSync(path.join(VISIBLE_EXTENSION_PATH, 'package.json'), { force: true })
    fs.writeFileSync(path.join(VISIBLE_EXTENSION_PATH, 'package.json'), packageContent, 'utf8')
  } catch {
    // fallback: if source package cannot be read, keep destination as-is
  }
}

function resolvePrimaryLoadTarget() {
  const sourceRealPath = safeRealpath(SOURCE_EXTENSION_PATH)
  const candidates = [
    { path: GLOBAL_EXTENSION_PATH, kind: 'global-skill' },
    { path: PRIVATE_EXTENSION_PATH, kind: 'private-skill' },
    { path: SOURCE_EXTENSION_PATH, kind: 'checkout' },
  ]

  for (const candidate of candidates) {
    const candidateRealPath = safeRealpath(candidate.path)
    if (sourceRealPath && candidateRealPath && candidateRealPath === sourceRealPath) {
      return candidate
    }
  }

  return { path: SOURCE_EXTENSION_PATH, kind: 'checkout' }
}

function describePrimaryLoadPathKind(kind) {
  if (kind === 'global-skill') return 'global skills install'
  if (kind === 'private-skill') return 'Codex compatibility install'
  return 'current checkout'
}

function prepareVisibleExtensionCopy(sourceVersion) {
  let visibleVersion = readManifestVersion(VISIBLE_EXTENSION_PATH)
  let updated = false
  let copyFailed = false

  if (!sourceVersion) {
    return {
      visibleVersion,
      updated,
      copyFailed,
    }
  }

  if (!visibleVersion || visibleVersion !== sourceVersion) {
    try {
      fs.mkdirSync(VISIBLE_ROOT, { recursive: true })
      fs.rmSync(VISIBLE_EXTENSION_PATH, { recursive: true, force: true })
      fs.cpSync(SOURCE_EXTENSION_PATH, VISIBLE_EXTENSION_PATH, {
        recursive: true,
        dereference: true,
      })
      refreshVisiblePackageManifest()
      visibleVersion = sourceVersion
      updated = true
    } catch {
      copyFailed = true
      visibleVersion = readManifestVersion(VISIBLE_EXTENSION_PATH)
    }
  }

  return {
    visibleVersion,
    updated,
    copyFailed,
  }
}

function refreshInstallBundle(log = () => {}, options = {}) {
  const prepareVisible = options.prepareVisible !== false
  const printHint = options.printHint !== false

  const sourceVersion = readManifestVersion(SOURCE_EXTENSION_PATH)
  const relayVersion = readPackageVersion()
  const primaryTarget = resolvePrimaryLoadTarget()
  const primaryRoot = path.dirname(primaryTarget.path)
  const primaryVersion =
    primaryTarget.path === SOURCE_EXTENSION_PATH
      ? sourceVersion
      : readManifestVersion(primaryTarget.path)
  const readActiveTabPath = path.join(primaryRoot, 'scripts', 'read-active-tab.js')
  const preflightPath = path.join(primaryRoot, 'scripts', 'preflight.sh')
  const relayManagerPath = path.join(primaryRoot, 'scripts', 'relay-manager.js')

  let visibleVersion = readManifestVersion(VISIBLE_EXTENSION_PATH)
  let updated = false
  let copyFailed = false

  if (!sourceVersion) {
    return {
      ok: false,
      path: primaryTarget.path,
      pathKind: primaryTarget.kind,
      rootPath: primaryRoot,
      readActiveTabPath,
      preflightPath,
      relayManagerPath,
      sourcePath: SOURCE_EXTENSION_PATH,
      visiblePath: VISIBLE_EXTENSION_PATH,
      installedVersion: primaryVersion,
      visibleVersion,
      sourceVersion,
      relayVersion,
      updated,
      firstRun: false,
      versionMismatch: false,
      sourceMissing: true,
      copyFailed,
      visiblePathReady: false,
      visiblePathNeedsRefresh: false,
    }
  }

  if (prepareVisible) {
    const visibleCopy = prepareVisibleExtensionCopy(sourceVersion)
    visibleVersion = visibleCopy.visibleVersion
    updated = visibleCopy.updated
    copyFailed = visibleCopy.copyFailed
  }

  const visiblePathReady = Boolean(sourceVersion && visibleVersion && visibleVersion === sourceVersion)
  const visiblePathNeedsRefresh = Boolean(sourceVersion && (!visibleVersion || visibleVersion !== sourceVersion))
  const versionMismatch = Boolean(primaryVersion && relayVersion && primaryVersion !== relayVersion)

  const state = readInstallState()
  const now = Date.now()
  const firstRun = state.firstRunSeen !== true
  const lastHintAt = Number.isFinite(Number(state.lastHintAt)) ? Number(state.lastHintAt) : 0
  const shouldPrintHint =
    versionMismatch ||
    copyFailed ||
    visiblePathNeedsRefresh ||
    firstRun ||
    (now - lastHintAt >= PROMPT_COOLDOWN_MS)

  if (printHint && shouldPrintHint) {
    if (firstRun) {
      log('First run setup for this machine:')
      log('1) Open Chrome and visit chrome://extensions')
      log('2) Enable Developer mode (top-right)')
      log('3) Click "Load unpacked"')
      log('4) Select this folder:')
      log(`   ${primaryTarget.path}`)
      log('5) Pin Agent Browser Relay in the toolbar (optional but recommended)')
      log('')
    }

    log('Primary Chrome extension path:')
    log(`  ${primaryTarget.path}`)
    log(`This is the guaranteed extension folder from the ${describePrimaryLoadPathKind(primaryTarget.kind)}.`)
    log('Load this folder in chrome://extensions (Load unpacked).')

    if (visiblePathReady) {
      log('Optional visible convenience path:')
      log(`  ${VISIBLE_EXTENSION_PATH}`)
    } else {
      log('Optional visible convenience path is not prepared:')
      log(`  ${VISIBLE_EXTENSION_PATH}`)
      log('If you want that shortcut, run `npm run extension:install` from the installed skill directory.')
    }

    log(`Extension version: ${primaryVersion || 'unknown'}`)
    log(`Relay package version: ${relayVersion || 'unknown'}`)
    if (visibleVersion) {
      log(`Visible convenience version: ${visibleVersion}`)
    }
    if (versionMismatch) {
      log('Version mismatch detected. Download newest extension bundle from:')
      log(`  ${PROJECT_URL}`)
      log('Or update from releases:')
      log(`  ${PROJECT_RELEASES_URL}`)
    }
  }

  if (printHint) {
    writeInstallState({
      lastHintAt: now,
      firstRunSeen: true,
      lastCheckedAt: now,
      primaryPath: primaryTarget.path,
      primaryPathKind: primaryTarget.kind,
      installedVersion: primaryVersion,
      visibleVersion,
      relayVersion,
      sourceVersion,
      mismatch: versionMismatch,
      visiblePathReady,
      visiblePathNeedsRefresh,
    })
  }

  return {
    ok: prepareVisible ? !copyFailed : true,
    path: primaryTarget.path,
    pathKind: primaryTarget.kind,
    rootPath: primaryRoot,
    readActiveTabPath,
    preflightPath,
    relayManagerPath,
    sourcePath: SOURCE_EXTENSION_PATH,
    visiblePath: VISIBLE_EXTENSION_PATH,
    installedVersion: primaryVersion,
    visibleVersion,
    sourceVersion,
    relayVersion,
    updated,
    firstRun,
    versionMismatch,
    sourceMissing: false,
    copyFailed,
    visiblePathReady,
    visiblePathNeedsRefresh,
  }
}

function describeInstallBundleFailure(result) {
  const targetPath = result?.visiblePath || VISIBLE_EXTENSION_PATH
  const primaryPath = result?.path || SOURCE_EXTENSION_PATH
  if (result?.sourceMissing) {
    return `[agent-browser-relay] Failed to resolve the Chrome extension files from ${SOURCE_EXTENSION_PATH}.`
  }
  if (result?.copyFailed) {
    return [
      `[agent-browser-relay] Failed to prepare the optional visible extension folder at ${targetPath}: copy failed.`,
      `Load the primary extension path instead: ${primaryPath}.`,
      `Check that ${VISIBLE_ROOT} is writable and retry \`npm run extension:install\`.`,
    ].join(' ')
  }
  return [
    `[agent-browser-relay] Failed to prepare the optional visible extension folder at ${targetPath}.`,
    `Load the primary extension path instead: ${primaryPath}.`,
  ].join(' ')
}

function parseCliArgs(args) {
  const options = {
    json: false,
    paths: false,
  }

  for (const arg of args) {
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--paths') {
      options.paths = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function printPathSummary(result) {
  console.log('Primary skill root:')
  console.log(`  ${result.rootPath}`)
  console.log('Primary Chrome extension path:')
  console.log(`  ${result.path}`)
  console.log(`Primary path source: ${describePrimaryLoadPathKind(result.pathKind)}`)
  console.log('Stable read CLI path:')
  console.log(`  ${result.readActiveTabPath}`)
  console.log('Stable preflight path:')
  console.log(`  ${result.preflightPath}`)

  if (result.visiblePathReady) {
    console.log('Optional visible convenience path:')
    console.log(`  ${result.visiblePath}`)
  } else {
    console.log('Optional visible convenience path is not prepared:')
    console.log(`  ${result.visiblePath}`)
    console.log('Run `npm run extension:install` from the installed skill directory if you want that shortcut.')
  }
}

function runCli() {
  let args
  try {
    args = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }

  if (args.help) {
    console.log('Usage:')
    console.log('  node scripts/extension-install-helper.js           # prepare optional visible convenience path')
    console.log('  node scripts/extension-install-helper.js --paths   # print primary extension + stable script paths')
    console.log('  node scripts/extension-install-helper.js --json    # output install status and paths as JSON')
    return
  }

  const result = refreshInstallBundle(
    args.paths || args.json
      ? () => {}
      : (message) => {
          console.error(`[agent-browser-relay] ${message}`)
        },
    {
      prepareVisible: !(args.paths || args.json),
      printHint: !(args.paths || args.json),
    },
  )

  if (args.json) {
    console.log(`${JSON.stringify(result, null, 2)}\n`)
  } else if (args.paths) {
    printPathSummary(result)
  }

  if (result.sourceMissing) {
    console.error(describeInstallBundleFailure(result))
    process.exitCode = 1
    return
  }

  if (!args.paths && result.ok !== true) {
    console.error(describeInstallBundleFailure(result))
    process.exitCode = 1
  }
}

if (require.main === module) {
  runCli()
}

module.exports = {
  describeInstallBundleFailure,
  refreshInstallBundle,
}
