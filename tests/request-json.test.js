const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const scriptNames = ['read-active-tab.js', 'relay-manager.js', 'extension-status.js'];

function loadRequestJson(scriptName) {
  // Exercise each production helper without executing CLI startup, installation,
  // or service-management side effects.
  const filename = path.join(root, 'scripts', scriptName);
  const source = fs.readFileSync(filename, 'utf8');
  const match = source.match(/^function requestJson\([\s\S]*?^\}/m);
  assert.ok(match, `Missing requestJson helper in ${scriptName}`);
  return vm.runInNewContext(`(${match[0]})`, {
    http, URL, Buffer, Error, JSON, DEFAULT_STATUS_TIMEOUT_MS: 100,
  }, { filename });
}

async function startServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/status?all=true`;
}

async function assertRejectsPromptly(promise, pattern) {
  let timer;
  try {
    await assert.rejects(Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('requestJson did not settle')), 1500);
      }),
    ]), pattern);
  } finally {
    clearTimeout(timer);
  }
}

for (const scriptName of scriptNames) {
  const requestJson = loadRequestJson(scriptName);

  for (const body of ['{"ok":', '{"ok":true}']) {
    test(`${scriptName}: rejects truncated Content-Length response ${JSON.stringify(body)}`, async (t) => {
      const url = await startServer(t, (_req, res) => {
        res.writeHead(200, {
          'Content-Length': Buffer.byteLength(body) + 10,
          Connection: 'close',
        });
        res.end(body);
      });
      // Even syntactically complete JSON is not a complete HTTP response here.
      await assertRejectsPromptly(requestJson(url, 100), /Relay response aborted|aborted/);
    });
  }

  test(`${scriptName}: rejects an interrupted chunked response`, async (t) => {
    const url = await startServer(t, (_req, res) => {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.write('{"ok":', () => res.socket.end());
    });
    await assertRejectsPromptly(requestJson(url, 100), /Relay response aborted|aborted/);
  });

  test(`${scriptName}: still reads a complete multi-chunk JSON response`, async (t) => {
    const url = await startServer(t, (req, res) => {
      assert.equal(req.url, '/status?all=true');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok":');
      setImmediate(() => res.end('true}'));
    });
    assert.deepEqual(await requestJson(url, 1000), { ok: true });
  });

  test(`${scriptName}: still accepts an empty 200 response`, async (t) => {
    const url = await startServer(t, (_req, res) => res.end());
    assert.deepEqual(await requestJson(url, 1000), {});
  });

  test(`${scriptName}: still rejects invalid JSON`, async (t) => {
    const url = await startServer(t, (_req, res) => res.end('{'));
    await assertRejectsPromptly(requestJson(url, 100), /Invalid JSON from relay/);
  });

  test(`${scriptName}: still rejects non-200 responses`, async (t) => {
    const url = await startServer(t, (_req, res) => {
      res.writeHead(503);
      res.end('{"error":"unavailable"}');
    });
    await assertRejectsPromptly(requestJson(url, 100), /HTTP 503/);
  });

  test(`${scriptName}: still times out while waiting for headers`, async (t) => {
    const url = await startServer(t, () => {});
    await assertRejectsPromptly(requestJson(url, 100), /Status request timeout|HTTP timeout/);
  });

  test(`${scriptName}: still times out on a stalled response body`, async (t) => {
    const url = await startServer(t, (_req, res) => {
      res.writeHead(200, { 'Content-Length': 100 });
      res.write('{"ok":');
    });
    await assertRejectsPromptly(requestJson(url, 100), /Status request timeout|HTTP timeout/);
  });

  test(`${scriptName}: still rejects a connection closed before headers`, async (t) => {
    const url = await startServer(t, (req) => req.socket.destroy());
    await assertRejectsPromptly(requestJson(url, 100), /socket hang up/);
  });
}

test('relay-manager.js: preserves POST JSON bodies and query strings', async (t) => {
  const requestJson = loadRequestJson('relay-manager.js');
  const payload = { ports: [18793], label: 'caf\u00e9' };
  const url = await startServer(t, (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/status?all=true');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(Number(req.headers['content-length']), Buffer.byteLength(JSON.stringify(payload)));
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.deepEqual(JSON.parse(body), payload);
      res.end('{"ok":true}');
    });
  });
  assert.deepEqual(await requestJson(url, 1000, { method: 'post', body: payload }), { ok: true });
});
