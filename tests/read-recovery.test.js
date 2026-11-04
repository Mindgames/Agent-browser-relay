const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/read-active-tab.js'), 'utf8');

// The CLI starts a socket at module load. Exercise its unchanged recovery functions
// without launching the CLI, refreshing an install, or connecting to a browser.
function readFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `Missing production function ${name}`);
  return match[0];
}

const recoverySource = [
  'isRecoverableRelayError',
  'evaluateWithRecovery',
  'captureScreenshotWithRecovery',
].map(readFunction).join('\n');

function createRecovery(operation, errors) {
  const result = operation === 'read' ? { result: { value: 'Example page' } } : { data: 'aW1hZ2U=' };
  const state = { attempts: 0, preparations: 0, delays: [] };
  const context = vm.createContext({
    Error,
    maxRetries: 2,
    retryDelayMs: 400,
    getResolvedExpression: () => 'document.title',
    prepareTargetTabForCommand: async () => { state.preparations += 1; },
    sleep: async (delay) => { state.delays.push(delay); },
    sendRelayCommand: async (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression === '1 + 1') {
        return { result: { value: 2 } };
      }
      assert.equal(method, operation === 'read' ? 'Runtime.evaluate' : 'Page.captureScreenshot');
      state.attempts += 1;
      const error = errors[state.attempts - 1];
      if (error) throw error;
      return result;
    },
  });
  vm.runInContext(recoverySource, context);
  return {
    result,
    state,
    run: () => operation === 'read'
      ? context.evaluateWithRecovery()
      : context.captureScreenshotWithRecovery({ format: 'png', quality: null, fullPage: false, timeoutMs: 15000 }),
  };
}

for (const operation of ['read', 'screenshot']) {
  for (const message of ['Relay browser disconnected', 'Relay disconnected']) {
    test(`${operation} recovers after a transient ${message}`, async () => {
      const recovery = createRecovery(operation, [new Error(message)]);
      assert.equal(await recovery.run(), recovery.result);
      assert.equal(recovery.state.attempts, 2);
      assert.equal(recovery.state.preparations, 2);
      assert.deepEqual(recovery.state.delays, [400]);
    });
  }

  test(`${operation} stops after the configured browser-disconnect retry budget`, async () => {
    const error = new Error('Relay browser disconnected');
    const recovery = createRecovery(operation, [error, error, error]);
    await assert.rejects(recovery.run(), (actual) => actual === error);
    assert.equal(recovery.state.attempts, 3);
    assert.equal(recovery.state.preparations, 3);
    assert.deepEqual(recovery.state.delays, [400, 400]);
  });

  test(`${operation} does not retry an unrelated command failure`, async () => {
    const error = new Error('Tab is leased by another session');
    const recovery = createRecovery(operation, [error]);
    await assert.rejects(recovery.run(), (actual) => actual === error);
    assert.equal(recovery.state.attempts, 1);
    assert.equal(recovery.state.preparations, 1);
    assert.deepEqual(recovery.state.delays, []);
  });
}
