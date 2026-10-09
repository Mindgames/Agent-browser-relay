#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function findJavaScriptFiles(directory, recursive = true) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive && entry.name !== 'node_modules') {
      return findJavaScriptFiles(file);
    }
    return entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
  }).sort();
}

const files = [
  ...findJavaScriptFiles(root, false),
  ...['extension', 'scripts', 'tests'].flatMap((directory) => findJavaScriptFiles(path.join(root, directory))),
];

for (const file of files) {
  // Node accepts only one entry point after --check; later arguments are not checked.
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Unable to check ${path.relative(root, file)}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
