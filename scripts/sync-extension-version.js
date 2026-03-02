#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT_DIR = path.join(__dirname, '..')
const ROOT_PACKAGE_PATH = path.join(ROOT_DIR, 'package.json')
const EXTENSION_DIR = path.join(ROOT_DIR, 'extension')
const EXTENSION_PACKAGE_PATH = path.join(EXTENSION_DIR, 'package.json')
const EXTENSION_MANIFEST_PATH = path.join(EXTENSION_DIR, 'manifest.json')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function ensureLinkedPackageFile() {
  const desiredTarget = '../package.json'
  let shouldLink = true

  try {
    const stat = fs.lstatSync(EXTENSION_PACKAGE_PATH)
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(EXTENSION_PACKAGE_PATH)
      if (currentTarget === desiredTarget) {
        shouldLink = false
      } else {
        fs.rmSync(EXTENSION_PACKAGE_PATH, { force: true })
      }
    } else {
      fs.rmSync(EXTENSION_PACKAGE_PATH, { force: true })
    }
  } catch {
    // target does not exist
  }

  if (shouldLink) {
    fs.symlinkSync(desiredTarget, EXTENSION_PACKAGE_PATH, 'file')
  }
}

function syncManifestVersion(version) {
  const manifest = readJson(EXTENSION_MANIFEST_PATH)
  if (manifest.version === version) {
    return false
  }

  manifest.version = version
  writeJson(EXTENSION_MANIFEST_PATH, manifest)
  return true
}

function main() {
  ensureLinkedPackageFile()

  const rootPackage = readJson(ROOT_PACKAGE_PATH)
  const nextVersion = String(rootPackage.version || '').trim()
  if (!nextVersion) return

  const changed = syncManifestVersion(nextVersion)
  if (changed) {
    process.stdout.write(`Synced extension manifest version to ${nextVersion}\n`)
  }
}

main()
