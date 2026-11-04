const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/read-active-tab.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production section ${start}`);
  return source.slice(from, to);
}

// Execute the real argument parsing, status normalization, and checkBridge flow.
// Only transport and tab commands are replaced; no browser or installed skill is used.
const production = [
  section('function parseArgs(argv)', 'function resolveExpressionInput'),
  section('function parseOptionalTabId', 'function parseRegexOption'),
  section('function parseStatusPort', 'async function ensureBridgeReadyForCommand'),
  section('async function checkBridge()', 'async function captureScreenshotWithRecovery'),
  'const options = parseArgs(argv);',
  section('const requestedTabRef =', 'const textRegex ='),
  section('let relaySessionId =', 'function getRelaySource()'),
].join('\n');

function browser(browserId, allowed, tabId) {
  return {
    browserId, extensionConnected: true, allowTargetCreate: allowed,
    attachedTabs: tabId ? [{ tabId, browserId, tabRef: `${browserId}:${tabId}` }] : [],
  };
}
function statusFor(shape, browsers, aggregate = true) {
  const port = {
    port: 18793, extensionConnected: browsers.some(item => item.extensionConnected),
    browsers, allowTargetCreate: aggregate,
    attachedTabs: browsers.flatMap(item => item.attachedTabs),
  };
  const unrelated = { ...port, port: 18794, browsers: [browser('other-port', true)] };
  if (shape === 'all-ports') return { ports: [unrelated, port] };
  if (shape === 'combined') return { ...unrelated, ports: [unrelated, port] };
  return port;
}
async function check(argv, status, { requireTargetCreate = true } = {}) {
  let commands = 0;
  const context = vm.createContext({
    argv, process: { env: {} }, relayPort: 18793, relayHost: '127.0.0.1',
    relayStatusUrl: 'http://fixture.invalid/status', timeoutMs: 100,
    requireTargetCreate, getRelayStatus: async () => ({ ok: true, ...status }),
    sendRelayPing: async () => {}, getRelaySource: () => ({}),
    ensureRelayTargetLease: async () => { commands++; },
    sendRelayCommand: async () => { commands++; return { ok: true, result: { value: 2 } }; },
  });
  vm.runInContext(production, context);
  const result = await vm.runInContext('checkBridge()', context);
  return { result: JSON.parse(JSON.stringify(result)), commands };
}

for (const shape of ['single-port', 'all-ports', 'combined']) {
  for (const [label, argv] of [
    ['browser-only', ['--browser-id', 'selected']],
    ['tab-ref', ['--tab-ref', 'selected:202']],
    ['browser and tab', ['--browser-id', 'selected', '--tab-id', '202']],
    ['numeric tab', ['--tab-id', '202']],
  ]) {
    test(`${shape}: ${label} rejects a disabled selected browser despite enabled aggregate`, async () => {
      const { result, commands } = await check(argv, statusFor(shape, [browser('other', true, 101), browser('selected', false, 202)]));
      assert.equal(result.ok, false);
      assert.equal(result.blocker.code, 'TARGET_CREATE_DISABLED');
      assert.equal(result.relay.targetCreateAllowed, false);
      assert.equal(commands, 0);
    });
    test(`${shape}: ${label} accepts an enabled selected browser despite disabled aggregate`, async () => {
      const { result } = await check(argv, statusFor(shape, [browser('selected', true, 202), browser('other', false, 101)], false));
      assert.equal(result.ok, true);
      assert.equal(result.relay.targetCreateAllowed, true);
    });
  }
  test(`${shape}: a missing explicit browser never borrows another browser's permission`, async () => {
    const { result } = await check(['--browser-id', 'missing'], statusFor(shape, [browser('other', true)]));
    assert.equal(result.ok, false);
    assert.equal(result.blocker.code, 'TARGET_CREATE_BROWSER_DISCONNECTED');
    assert.equal(result.relay.targetCreateAllowed, null);
  });
  test(`${shape}: an unselected multi-browser check reports ambiguity`, async () => {
    const { result } = await check([], statusFor(shape, [browser('one', true), browser('two', true)]));
    assert.equal(result.ok, false);
    assert.equal(result.blocker.code, 'TARGET_CREATE_BROWSER_AMBIGUOUS');
    assert.equal(result.blocker.retryable, false);
  });
  test(`${shape}: colliding numeric tabs require a browser-scoped selector`, async () => {
    const status = statusFor(shape, [browser('one', true, 202), browser('two', true, 202)]);
    const { result } = await check(['--tab-id', '202'], status);
    assert.equal(result.ok, false);
    assert.equal(result.blocker.code, 'TARGET_CREATE_BROWSER_AMBIGUOUS');
    assert.equal((await check(['--tab-ref', 'two:202'], status)).result.ok, true);
  });
  test(`${shape}: canonical tab refs take precedence over conflicting browser arguments`, async () => {
    const { result } = await check(['--tab-ref', 'selected:202', '--browser-id', 'other'], statusFor(shape, [browser('other', true, 101), browser('selected', false, 202)]));
    assert.equal(result.blocker.code, 'TARGET_CREATE_DISABLED');
  });
  test(`${shape}: unknown selected capability does not borrow aggregate state`, async () => {
    const { result } = await check(['--browser-id', 'selected'], statusFor(shape, [browser('selected', null)]));
    assert.equal(result.blocker.code, 'TARGET_CREATE_UNKNOWN');
    assert.equal(result.relay.targetCreateAllowed, null);
  });
}

test('a single modern browser remains selectable without arguments', async () => {
  assert.equal((await check([], statusFor('single-port', [browser('only', true)]))).result.ok, true);
  assert.equal((await check([], statusFor('single-port', [browser('only', false)]))).result.blocker.code, 'TARGET_CREATE_DISABLED');
});

test('a disconnected selected browser is not ready', async () => {
  const selected = { ...browser('selected', true), extensionConnected: false };
  const { result } = await check(['--browser-id', 'selected'], statusFor('single-port', [browser('other', true), selected]));
  assert.equal(result.blocker.code, 'TARGET_CREATE_BROWSER_DISCONNECTED');
});

test('legacy status without browsers preserves capability behavior', async () => {
  for (const allowed of [true, false, null]) {
    const { result } = await check([], { port: 18793, extensionConnected: true, allowTargetCreate: allowed });
    assert.equal(result.ok, allowed === true);
    if (allowed !== true) assert.equal(result.blocker.code, allowed === false ? 'TARGET_CREATE_DISABLED' : 'TARGET_CREATE_UNKNOWN');
  }
});

test('ordinary checks do not require the target-create capability', async () => {
  const { result, commands } = await check(['--browser-id', 'selected', '--tab-id', '202'], statusFor('single-port', [browser('other', true, 101), browser('selected', false, 202)]), { requireTargetCreate: false });
  assert.equal(result.ok, true);
  assert.ok(commands > 0);
});

for (const browsers of [null, {}, 'invalid', [null], [{ extensionConnected: true, allowTargetCreate: true }], [browser('', true)], [browser('valid', true), { extensionConnected: true, allowTargetCreate: true }]]) {
  test(`malformed modern browser status cannot inherit aggregate permission: ${JSON.stringify(browsers)}`, async () => {
    const status = { port: 18793, extensionConnected: true, allowTargetCreate: true, browsers };
    for (const argv of [[], ['--browser-id', 'missing']]) {
      const { result } = await check(argv, status);
      assert.equal(result.ok, false);
      assert.equal(result.blocker.code, 'TARGET_CREATE_BROWSER_DISCONNECTED');
      assert.equal(result.relay.targetCreateAllowed, null);
    }
  });
}

test('a missing numeric tab still uses the existing tab-not-attached blocker', async () => {
  const { result, commands } = await check(['--tab-id', '999'], statusFor('single-port', [browser('only', true, 101)]));
  assert.equal(result.ok, false);
  assert.equal(result.blocker.code, 'TAB_NOT_ATTACHED');
  assert.equal(commands, 0);
});
