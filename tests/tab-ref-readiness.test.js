const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Load production parsing/readiness functions without CLI startup, filesystem
// refreshes, a browser, or a relay service. Only transport boundaries are stubbed.
const source = fs.readFileSync(path.join(__dirname, '../scripts/read-active-tab.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production section: ${start}`);
  return source.slice(from, to);
}
const production = [
  section('function parseArgs(argv)', 'function resolveExpressionInput'),
  section('function parseOptionalTabId', 'function parseRegexOption'),
  'const options = parseArgs(argv);',
  section('const requestedTabRef =', 'const textRegex ='),
  section('function parseStatusPort', 'async function buildInitialConnectionFailureState'),
  section('async function checkBridge()', 'async function captureScreenshotWithRecovery'),
].join('\n');

function tab(browserId, leasedSessionId = null, tabId = 101) {
  return { tabId, tabRef: `${browserId}:${tabId}`, browserId, title: `${browserId} tab`, leasedSessionId };
}
function statusFor(tabs, otherPorts = []) {
  const port = { port: 18793, extensionConnected: true, attachedTabs: tabs };
  return { ok: true, ...port, ports: [port, ...otherPorts] };
}
function reader(argv, status, overrides = {}) {
  const calls = [];
  const context = vm.createContext({
    argv,
    process: { env: {} },
    relayPort: 18793,
    relayHost: '127.0.0.1',
    relayStatusUrl: 'http://fixture.invalid/status',
    relaySessionId: null,
    requireTargetCreate: false,
    timeoutMs: 100,
    getRelaySource: () => ({}),
    getRelayStatus: async () => status,
    sendRelayPing: async () => { calls.push('ping'); },
    ensureRelayTargetLease: async () => { calls.push('claim'); },
    sendRelayCommand: async (method) => {
      calls.push(method);
      return { ok: true, result: { value: 2 } };
    },
    ...overrides,
  });
  vm.runInContext(production, context);
  return {
    calls,
    run: expression => vm.runInContext(expression, context),
    check: () => vm.runInContext('checkBridge()', context),
    metadata: () => vm.runInContext('ensureMetadataReadyForCommand()', context),
  };
}

const targets = [
  ['tab-ref', ['--tab-ref', 'chrome-profile:101']],
  ['browser-id + tab-id', ['--browser-id', 'chrome-profile', '--tab-id', '101']],
];
for (const [label, argv] of targets) {
  for (const targetFirst of [false, true]) {
    const order = targetFirst ? 'selected first' : 'other first';
    const selected = tab('chrome-profile');
    const other = tab('brave-profile', 'other-controller');
    const tabs = targetFirst ? [selected, other] : [other, selected];

    test(`${label}: readiness selects the free browser tab (${order})`, async () => {
      const r = reader(argv, statusFor(tabs));
      assert.equal(r.run('requestedTabRefValue'), 'chrome-profile:101');
      const result = await r.check();
      assert.equal(result.ok, true, JSON.stringify(result.blocker));
      assert.equal(result.blocker, null);
      assert.deepEqual(r.calls, ['ping', 'claim', 'Grais.debugger.attachTab', 'Runtime.evaluate']);
    });

    test(`${label}: metadata selects the free browser tab (${order})`, async () => {
      const r = reader(argv, statusFor(tabs));
      await r.metadata();
      assert.deepEqual(r.calls, ['claim']);
    });
  }

  test(`${label}: the selected browser's lease still blocks readiness and metadata`, async () => {
    const status = statusFor([tab('brave-profile'), tab('chrome-profile', 'selected-owner')]);
    const r = reader(argv, status);
    const result = await r.check();
    assert.equal(result.ok, false);
    assert.equal(result.blocker.code, 'TAB_LEASED_BY_OTHER_SESSION');
    assert.match(result.blocker.summary, /selected-owner/);
    assert.match(result.blocker.detail, /chrome-profile:101/);
    await assert.rejects(r.metadata(), error => error.readinessState.blocker.code === 'TAB_LEASED_BY_OTHER_SESSION');
    assert.deepEqual(r.calls, []);
  });

  test(`${label}: a lease owned by this session remains usable`, async () => {
    const r = reader(argv, statusFor([tab('brave-profile', 'other-owner'), tab('chrome-profile', 'this-session')]), {
      relaySessionId: 'this-session',
    });
    assert.equal((await r.check()).ok, true);
  });

  test(`${label}: a missing selected ref never falls back to the other browser`, async () => {
    const r = reader(argv, statusFor([tab('brave-profile')]));
    const result = await r.check();
    assert.equal(result.ok, false);
    assert.equal(result.blocker.code, 'TAB_NOT_ATTACHED');
    await assert.rejects(r.metadata(), error => error.readinessState.blocker.code === 'TAB_NOT_ATTACHED');
    assert.deepEqual(r.calls, []);
  });

  test(`${label}: a missing selected ref ignores an unrelated browser on another port`, async () => {
    const r = reader(argv, statusFor([], [{ port: 18794, extensionConnected: true, attachedTabs: [tab('brave-profile')] }]));
    const result = await r.check();
    assert.equal(result.blocker.code, 'TAB_NOT_ATTACHED');
    assert.deepEqual(r.calls, []);
  });

  test(`${label}: the selected ref on another port is still diagnosed`, async () => {
    const r = reader(argv, statusFor([tab('brave-profile', 'other-owner')], [
      { port: 18794, extensionConnected: true, attachedTabs: [tab('brave-profile'), tab('chrome-profile')] },
    ]));
    const result = await r.check();
    assert.equal(result.blocker.code, 'TAB_ATTACHED_ON_OTHER_PORT');
    assert.match(result.blocker.summary, /18794/);
    assert.match(result.blocker.detail, /chrome-profile:101/);
    assert.deepEqual(r.calls, []);
  });

  test(`${label}: command errors do not inherit another browser's lease blocker`, () => {
    const r = reader(argv, statusFor([tab('brave-profile', 'other-owner'), tab('chrome-profile')]));
    const blocker = r.run(`mapCommandErrorToBlocker('No response from relay bridge', summarizeRelayPorts(${JSON.stringify(statusFor([tab('brave-profile', 'other-owner'), tab('chrome-profile')]))}), requestedTabId)`);
    assert.equal(blocker.code, 'BRIDGE_NO_RESPONSE');
  });

  test(`${label}: command errors retain selected-target lease and port blockers`, () => {
    for (const [status, code] of [
      [statusFor([tab('brave-profile'), tab('chrome-profile', 'selected-owner')]), 'TAB_LEASED_BY_OTHER_SESSION'],
      [statusFor([tab('brave-profile')], [{ port: 18794, extensionConnected: true, attachedTabs: [tab('chrome-profile')] }]), 'TAB_ATTACHED_ON_OTHER_PORT'],
    ]) {
      const r = reader(argv, status);
      const blocker = r.run(`mapCommandErrorToBlocker('No response from relay bridge', summarizeRelayPorts(${JSON.stringify(status)}), requestedTabId)`);
      assert.equal(blocker.code, code);
    }
  });
}

test('an explicit tab-ref retains precedence over a conflicting numeric tab-id', async () => {
  const r = reader(['--tab-ref', 'chrome-profile:101', '--tab-id', '202'], statusFor([
    tab('chrome-profile', 'other-owner', 202), tab('chrome-profile'),
  ]));
  assert.equal(r.run('requestedTabId'), 202);
  assert.equal(r.run('requestedTabRefValue'), 'chrome-profile:101');
  // The relay already resolves explicit tabRef before numeric tabId. Readiness
  // must inspect the same identity without changing argument parsing policy.
  assert.equal((await r.check()).ok, true);
});

test('an explicit tab-ref is not replaced by a conflicting browser-id', async () => {
  const r = reader(['--tab-ref', 'chrome-profile:101', '--browser-id', 'brave-profile'], statusFor([
    tab('brave-profile', 'other-owner'), tab('chrome-profile'),
  ]));
  assert.equal((await r.check()).ok, true);
});

test('an explicit ref missing from legacy status stays blocked', async () => {
  const r = reader(['--tab-ref', 'chrome-profile:101'], statusFor([{ tabId: 101, browserId: 'chrome-profile' }]));
  assert.equal((await r.check()).blocker.code, 'TAB_NOT_ATTACHED');
  assert.deepEqual(r.calls, []);
});

test('numeric-only single-browser readiness and metadata remain usable', async () => {
  const r = reader(['--tab-id', '101'], statusFor([{ tabId: 101 }]));
  assert.equal((await r.check()).ok, true);
  await r.metadata();
  assert.equal(r.run('requestedTabRefValue'), null);
});

test('numeric-only lease conflicts and missing tabs retain their blockers', async () => {
  for (const [tabs, code] of [
    [[tab('chrome-profile', 'other-owner')], 'TAB_LEASED_BY_OTHER_SESSION'],
    [[tab('chrome-profile', null, 202)], 'TAB_NOT_ATTACHED'],
  ]) {
    const r = reader(['--tab-id', '101'], statusFor(tabs));
    assert.equal((await r.check()).blocker.code, code);
    assert.deepEqual(r.calls, []);
  }
});

test('numeric-only alternate-port diagnostics remain unchanged', async () => {
  const r = reader(['--tab-id', '101'], statusFor([], [{ port: 18794, extensionConnected: true, attachedTabs: [tab('chrome-profile')] }]));
  assert.equal((await r.check()).blocker.code, 'TAB_ATTACHED_ON_OTHER_PORT');
});

test('numeric-only duplicate ids still defer ambiguity to the relay', async () => {
  const r = reader(['--tab-id', '101'], statusFor([tab('brave-profile'), tab('chrome-profile')]), {
    ensureRelayTargetLease: async () => { throw new Error('Tab id 101 is attached in multiple browsers. Use tabRef.'); },
  });
  const result = await r.check();
  assert.equal(result.ok, false);
  assert.match(result.blocker.summary, /multiple browsers/);
  assert.deepEqual(r.calls, ['ping']);
});
