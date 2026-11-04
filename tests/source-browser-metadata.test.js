const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts/read-active-tab.js'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production section: ${start}`);
  return source.slice(from, to);
}

// Evaluate declarations and production argument/lease initialization only. Never
// execute CLI startup, install refreshes, sockets, or a live browser connection.
const production = [
  section('function parseArgs(argv)', 'function resolveExpressionInput'),
  section('function parseOptionalTabId', 'function parseRegexOption'),
  section('function getRelaySource()', "socket.addEventListener('open'"),
  section('function sanitizeBrowserIdentity', 'function summarizeRelayPorts'),
  section('function rememberLease', 'async function ensureRelaySession'),
  'const options = parseArgs(argv);',
  section('const requestedTabRef =', 'const textRegex ='),
  section('let relaySessionId =', 'function getRelaySource()'),
].join('\n');

function reader(argv, status, env = {}) {
  const context = vm.createContext({
    argv, process: { env },
    relayHost: '127.0.0.1', relayPort: 18793,
    relayStatusUrl: 'http://fixture.invalid/status',
    relayWebSocketUrl: 'ws://fixture.invalid/extension',
    installBundle: { sourceVersion: '0.0.14' }, SKILL_CAPABILITIES: {},
  });
  vm.runInContext(production, context);
  const setStatus = value => {
    context.fixtureStatus = value;
    vm.runInContext('relayStatusSnapshot = fixtureStatus', context);
  };
  setStatus(status);
  return {
    getSource: () => JSON.parse(JSON.stringify(vm.runInContext('getRelaySource()', context))),
    rememberLease: lease => {
      context.fixtureLease = lease;
      vm.runInContext('rememberLease(fixtureLease)', context);
    },
    setStatus,
  };
}

function browser(browserId, name, extensionVersion, tabId) {
  return {
    browserId, extensionConnected: true,
    browser: { name, family: 'chromium', version: `${name}-version`, profileId: browserId },
    extensionVersion, extensionCapabilities: { marker: browserId },
    attachedTabs: [{ tabId, browserId, tabRef: `${browserId}:${tabId}` }],
  };
}

function statusFor(shape, latest = 'chrome-profile', collide = false) {
  const chrome = browser('chrome-profile', 'Chrome', '0.0.14', 101);
  const brave = browser('brave-profile', 'Brave', '0.0.13', collide ? 101 : 202);
  const browsers = [chrome, brave];
  const primary = browsers.find(entry => entry.browserId === latest);
  const port = {
    port: 18793, browsers, browserCount: browsers.length,
    browser: primary.browser, extensionVersion: primary.extensionVersion,
    extensionCapabilities: primary.extensionCapabilities,
    attachedTabs: browsers.flatMap(entry => entry.attachedTabs),
  };
  const other = { ...chrome, port: 18794, browsers: [chrome] };
  if (shape === 'all-ports') return { ports: [null, other, port] };
  if (shape === 'combined') return { ...other, ports: [other, port] };
  return port;
}

function assertBrave(value) {
  assert.equal(value.browser.profileId, 'brave-profile');
  assert.equal(value.browser.name, 'Brave');
  assert.equal(value.extension.observedExtensionVersion, '0.0.13');
  assert.deepEqual(value.extension.observedCapabilities, { marker: 'brave-profile' });
  assert.equal(value.extension.observedVersionMismatch, true);
  assert.equal(value.extension.versionMismatch, true);
  assert.equal(value.extension.expectedExtensionVersion, '0.0.14');
}

function assertUnknown(value) {
  assert.equal(value.browser, null);
  assert.equal(value.extension.observedExtensionVersion, null);
  assert.equal(value.extension.observedCapabilities, null);
  assert.equal(value.extension.observedVersionMismatch, false);
}

for (const shape of ['single-port', 'all-ports', 'combined']) {
  for (const [label, argv] of [
    ['tab-ref', ['--tab-ref', 'brave-profile:202']],
    ['browser and tab', ['--browser-id', 'brave-profile', '--tab-id', '202']],
    ['numeric tab', ['--tab-id', '202']],
    ['browser-only', ['--browser-id', 'brave-profile']],
  ]) {
    for (const latest of ['chrome-profile', 'brave-profile']) {
      test(`${shape}: ${label} reports selected metadata when ${latest} heartbeats last`, () => {
        assertBrave(reader(argv, statusFor(shape, latest)).getSource());
      });
    }
  }

  test(`${shape}: explicit tab refs disambiguate identical numeric tab IDs`, () => {
    const status = statusFor(shape, 'chrome-profile', true);
    assertBrave(reader(['--tab-ref', 'brave-profile:101'], status).getSource());
    assertUnknown(reader(['--tab-id', '101'], status).getSource());
  });

  test(`${shape}: missing browser or numeric tab never inherits aggregate metadata`, () => {
    for (const argv of [['--tab-ref', 'missing-profile:101'], ['--tab-id', '999']]) {
      assertUnknown(reader(argv, statusFor(shape)).getSource());
    }
  });

  test(`${shape}: canonical tab ref takes precedence over conflicting raw browser and tab arguments`, () => {
    const r = reader(['--tab-ref', 'brave-profile:202', '--browser-id', 'chrome-profile', '--tab-id', '101'], statusFor(shape));
    assertBrave(r.getSource());
  });

  test(`${shape}: a canonical lease updates numeric-only provenance`, () => {
    const r = reader(['--tab-id', '101'], statusFor(shape, 'chrome-profile', true));
    assertUnknown(r.getSource());
    r.rememberLease({ tabRef: 'brave-profile:101', tabId: 101 });
    const result = r.getSource();
    assertBrave(result);
    assert.equal(result.tabRef, 'brave-profile:101');
    assert.equal(result.browserId, 'brave-profile');
    assert.equal(result.tabId, 101);
  });

  test(`${shape}: absent selected fields do not borrow fields from another browser`, () => {
    const status = statusFor(shape);
    const port = shape === 'single-port' ? status : status.ports.find(entry => entry?.port === 18793);
    const selected = port.browsers.find(entry => entry.browserId === 'brave-profile');
    delete selected.browser;
    delete selected.extensionVersion;
    delete selected.extensionCapabilities;
    assertUnknown(reader(['--tab-ref', 'brave-profile:202'], status).getSource());
  });

  test(`${shape}: legacy status without per-browser entries remains usable`, () => {
    const status = statusFor(shape);
    const port = shape === 'single-port' ? status : status.ports.find(entry => entry?.port === 18793);
    delete port.browsers;
    const result = reader(['--tab-id', '101'], status).getSource();
    assert.equal(result.browser.profileId, 'chrome-profile');
    assert.equal(result.extension.observedExtensionVersion, '0.0.14');
    assert.deepEqual(result.extension.observedCapabilities, { marker: 'chrome-profile' });
    assert.equal(result.extension.observedVersionMismatch, false);
  });

  test(`${shape}: unscoped manual reads retain port aggregate metadata`, () => {
    const result = reader([], statusFor(shape)).getSource();
    assert.equal(result.browser.profileId, 'chrome-profile');
    assert.equal(result.extension.observedExtensionVersion, '0.0.14');
    assert.deepEqual(result.extension.observedCapabilities, { marker: 'chrome-profile' });
  });
}

test('environment selectors use the same metadata resolution as CLI arguments', () => {
  assertBrave(reader([], statusFor('single-port'), { GRAIS_TAB_REF: 'brave-profile:202' }).getSource());
  assertBrave(reader([], statusFor('single-port'), { GRAIS_BROWSER_ID: 'brave-profile', GRAIS_TAB_ID: '202' }).getSource());
});

test('missing status and absent requested port return unknown metadata', () => {
  for (const status of [null, {}, { ports: [] }, { ports: [null, { port: 18794, ...browser('brave-profile', 'Brave', '0.0.13', 202) }] }]) {
    assertUnknown(reader(['--tab-ref', 'brave-profile:202'], status).getSource());
  }
});

test('selected browser disappearing from a refreshed snapshot clears its metadata', () => {
  const r = reader(['--tab-ref', 'brave-profile:202'], statusFor('single-port'));
  assertBrave(r.getSource());
  const status = statusFor('single-port');
  status.browsers = status.browsers.filter(entry => entry.browserId !== 'brave-profile');
  r.setStatus(status);
  assertUnknown(r.getSource());
});

test('production relay summaries keep selected provenance stable across unrelated heartbeats', () => {
  const relaySource = fs.readFileSync(path.join(root, 'relay-server.js'), 'utf8');
  const relay = vm.createContext({ host: '127.0.0.1', socketMeta: new WeakMap() });
  vm.runInContext([...relaySource.matchAll(/^(?:async )?function [^]*?^}/gm)].map(match => match[0]).join('\n'), relay);
  const state = relay.createPortState(18793);
  for (const entry of statusFor('single-port').browsers) {
    state.extensionClientsById.set(entry.browserId, {
      browserId: entry.browserId, browser: entry.browser, lastSeenTs: 1,
      socket: { OPEN: 1, readyState: 1 }, heartbeatState: entry,
    });
  }
  const r = reader(['--tab-ref', 'brave-profile:202'], null);
  let seenTs = 1;
  for (const latest of ['chrome-profile', 'brave-profile', 'chrome-profile']) {
    state.extensionClientsById.get(latest).lastSeenTs = ++seenTs;
    for (const status of [relay.getSinglePortStatus(state), { ports: [relay.summarizePortState(state)] }]) {
      r.setStatus(status);
      assertBrave(r.getSource());
    }
  }
});
