const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('package metadata identifies the public OSS project', () => {
  const pkg = readJson('package.json');

  assert.equal(pkg.name, 'agent-browser-relay');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.repository.url, /github\.com\/Mindgames\/Agent-browser-relay/);
  assert.ok(pkg.keywords.includes('chrome-extension'));
  assert.ok(pkg.keywords.includes('devtools-protocol'));
});

test('extension and package versions stay in sync', () => {
  const pkg = readJson('package.json');
  const manifest = readJson('extension/manifest.json');

  assert.equal(manifest.version, pkg.version);
});

test('canonical relay commands remain documented and script-backed', () => {
  const pkg = readJson('package.json');
  const agents = readText('AGENTS.md');
  const readme = readText('README.md');
  const scripts = pkg.scripts;
  const commands = [
    'extension:path',
    'extension:status',
    'relay:global:install',
    'relay:global:status',
    'relay:global:start',
    'relay:global:stop',
    'relay:start',
    'relay:status',
    'relay:doctor',
    'relay:stop'
  ];

  for (const command of commands) {
    assert.ok(scripts[command], `missing package script ${command}`);
    assert.match(agents, new RegExp(`npm run ${command.replace(':', ':')}`));
    assert.match(readme, new RegExp(`npm run ${command.replace(':', ':')}`));
  }

  assert.match(agents, /node scripts\/read-active-tab\.js/);
  assert.match(readme, /node scripts\/read-active-tab\.js/);
});
