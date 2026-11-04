const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');

const root = path.resolve(__dirname, '..');

function getFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to allocate test port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function waitForLine(child, pattern) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += String(chunk || '');
      if (!pattern.test(buffer)) return;
      cleanup();
      resolve(buffer);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Relay exited before readiness: code=${code} signal=${signal} output=${buffer}`));
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

function stopRelay(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 1000);
    killTimer.unref?.();

    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, 250);
    timer.unref?.();
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });

    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
      return;
    }
    socket.close();
  });
}

function connectExtension(host, port, browser, attachedTabs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${port}/extension`);
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(JSON.stringify({
        method: 'Grais.extensionHeartbeat',
        ts: Date.now(),
        relayPort: port,
        state: 'attached',
        status: 'ON',
        allowTargetCreate: false,
        activeTab: attachedTabs[0] || null,
        attachedTabs,
        extensionVersion: '0.0.14',
        extensionName: 'Agent Browser Relay',
        browser,
      }));
      resolve(socket);
    });
  });
}

function connectController(host, port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${port}/extension`);
    socket.once('error', reject);
    socket.once('open', () => resolve(socket));
  });
}

function waitForSocketJson(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for socket message'));
    }, 1200);
    const onMessage = (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw || ''));
      } catch {
        return;
      }
      if (!predicate(payload)) return;
      cleanup();
      resolve(payload);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}

function sendRequest(socket, id, method, params) {
  socket.send(JSON.stringify({
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  }));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1200 }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += String(chunk || '');
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
  });
}

test('one relay port keeps multiple browser extension clients connected', async (t) => {
  const host = 'localhost';
  const port = await getFreePort(host);
  const relay = spawn(process.execPath, [
    path.join(root, 'relay-server.js'),
    '--host',
    host,
    '--port',
    String(port),
    '--timeout',
    '1200',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    return stopRelay(relay);
  });

  await waitForLine(relay, /Agent Browser Relay listening/);

  const chrome = await connectExtension(host, port, {
    name: 'Chrome',
    family: 'chromium',
    version: '148.0.0.0',
    profileId: 'chrome-profile',
  }, [
    { tabId: 101, title: 'Chrome tab', url: 'https://chrome.example/', windowId: 1, sessionId: 'chrome-session', targetId: 'chrome-target', state: 'connected' },
  ]);
  t.after(() => closeSocket(chrome));

  const brave = await connectExtension(host, port, {
    name: 'Brave',
    family: 'chromium',
    version: '148.0.0.0',
    profileId: 'brave-profile',
  }, [
    { tabId: 101, title: 'Brave tab', url: 'https://brave.example/', windowId: 2, sessionId: 'brave-session', targetId: 'brave-target', state: 'connected' },
  ]);
  t.after(() => closeSocket(brave));

  const status = await fetchJson(`http://${host}:${port}/status?all=true`);
  const portStatus = status.ports.find((entry) => entry.port === port);

  assert.equal(status.extensionConnected, true);
  assert.equal(portStatus.extensionConnected, true);
  assert.deepEqual(
    portStatus.browsers.map((entry) => entry.browser.profileId).sort(),
    ['brave-profile', 'chrome-profile'],
  );
  assert.deepEqual(
    portStatus.attachedTabs.map((entry) => entry.tabRef).sort(),
    ['brave-profile:101', 'chrome-profile:101'],
  );
});

test('tabRef leases route duplicate tab ids to the owning browser', async (t) => {
  const host = 'localhost';
  const port = await getFreePort(host);
  const relay = spawn(process.execPath, [
    path.join(root, 'relay-server.js'),
    '--host',
    host,
    '--port',
    String(port),
    '--timeout',
    '1200',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    return stopRelay(relay);
  });

  await waitForLine(relay, /Agent Browser Relay listening/);

  const chrome = await connectExtension(host, port, {
    name: 'Chrome',
    family: 'chromium',
    version: '148.0.0.0',
    profileId: 'chrome-profile',
  }, [
    { tabId: 101, title: 'Chrome tab', url: 'https://chrome.example/', windowId: 1, sessionId: 'chrome-session', targetId: 'chrome-target', state: 'connected' },
  ]);
  t.after(() => closeSocket(chrome));

  const brave = await connectExtension(host, port, {
    name: 'Brave',
    family: 'chromium',
    version: '148.0.0.0',
    profileId: 'brave-profile',
  }, [
    { tabId: 101, title: 'Brave tab', url: 'https://brave.example/', windowId: 2, sessionId: 'brave-session', targetId: 'brave-target', state: 'connected' },
  ]);
  t.after(() => closeSocket(brave));

  const controller = await connectController(host, port);
  t.after(() => closeSocket(controller));

  sendRequest(controller, 1, 'Grais.relay.openSession', {
    client: 'test',
    tabRef: 'brave-profile:101',
  });
  const session = await waitForSocketJson(controller, (payload) => payload.id === 1);
  assert.equal(session.result.tabRef, 'brave-profile:101');

  sendRequest(controller, 2, 'forwardCDPCommand', {
    relaySessionId: session.result.sessionId,
    method: 'Runtime.evaluate',
    params: { expression: 'document.title' },
  });

  const braveCommand = await waitForSocketJson(brave, (payload) => payload.method === 'forwardCDPCommand');
  assert.equal(braveCommand.params.browserId, 'brave-profile');
  assert.equal(braveCommand.params.tabId, 101);
  assert.equal(braveCommand.params.tabRef, 'brave-profile:101');

  let chromeReceived = false;
  chrome.once('message', () => {
    chromeReceived = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(chromeReceived, false);
});


async function startCreationFixture(t) {
  const host = 'localhost';
  const port = await getFreePort(host);
  const relay = spawn(process.execPath, [
    path.join(root, 'relay-server.js'), '--host', host, '--port', String(port), '--timeout', '1200',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopRelay(relay));
  await waitForLine(relay, /Agent Browser Relay listening/);

  const browsers = {};
  for (const profileId of ['chrome-profile', 'brave-profile']) {
    const socket = await connectExtension(host, port, {
      name: profileId, family: 'chromium', profileId,
    }, []);
    t.after(() => closeSocket(socket));
    // Advertise the existing opt-in without attaching a tab first.
    socket.send(JSON.stringify({
      method: 'Grais.extensionHeartbeat',
      browser: { name: profileId, family: 'chromium', profileId },
      allowTargetCreate: true, attachedTabs: [],
    }));
    browsers[profileId] = socket;
  }
  const controller = await connectController(host, port);
  t.after(() => closeSocket(controller));
  const status = await fetchJson(`http://${host}:${port}/status`);
  assert.equal(status.browsers.length, 2);
  assert.deepEqual(status.attachedTabs, []);
  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    const response = waitForSocketJson(controller, (payload) => payload.id === id);
    sendRequest(controller, id, method, params);
    return response;
  };
  return { browsers, controller, request, host, port };
}

test('an unbound session can create and lease its first tab in the selected browser', async (t) => {
  const { browsers, request } = await startCreationFixture(t);
  const opened = await request('Grais.relay.openSession', {
    client: 'test',
  });
  assert.equal(opened.error, undefined);
  assert.equal(opened.result.tabRef, null);
  const sessionId = opened.result.sessionId;
  let otherBrowserCommands = 0;
  browsers['chrome-profile'].on('message', (raw) => {
    if (JSON.parse(String(raw)).method === 'forwardCDPCommand') otherBrowserCommands += 1;
  });
  let command;
  browsers['brave-profile'].once('message', (raw) => {
    command = JSON.parse(String(raw));
    browsers['brave-profile'].send(JSON.stringify({ id: command.id, result: { tabId: 202, targetId: 'created-target' } }));
  });
  const response = await request('forwardCDPCommand', {
    relaySessionId: sessionId, browserId: 'brave-profile',
    method: 'Target.createTarget', params: { url: 'about:blank' },
  });
  assert.equal(response.error, undefined);
  assert.equal(command.params.browserId, 'brave-profile');
  assert.equal(command.params.tabId, undefined);
  assert.equal(response.result.leasedTabRef, 'brave-profile:202');
  const session = await request('Grais.relay.getSession', { sessionId });
  assert.equal(session.result.tabRef, 'brave-profile:202');
  const conflictingOpen = await request('Grais.relay.openSession', { browserId: 'chrome-profile' });
  assert.ok(conflictingOpen.error);
  const conflictingCreate = await request('forwardCDPCommand', {
    relaySessionId: sessionId, browserId: 'chrome-profile',
    method: 'Target.createTarget', params: { url: 'about:blank' },
  });
  assert.ok(conflictingCreate.error, 'a browser-only request cannot redirect an existing tab lease');
  const evaluated = waitForSocketJson(browsers['brave-profile'], (payload) => payload.method === 'forwardCDPCommand');
  const evaluation = request('forwardCDPCommand', {
    relaySessionId: sessionId, method: 'Runtime.evaluate', params: { expression: 'document.title' },
  });
  const evaluateCommand = await evaluated;
  assert.equal(evaluateCommand.params.tabRef, 'brave-profile:202');
  browsers['brave-profile'].send(JSON.stringify({ id: evaluateCommand.id, result: { value: 'Blank' } }));
  await evaluation;
  assert.equal(otherBrowserCommands, 0);
});

test('explicit first-tab selection works after opening an unbound session and fails closed otherwise', async (t) => {
  const { browsers, request } = await startCreationFixture(t);
  const opened = await request('Grais.relay.openSession', { client: 'test' });
  const sessionId = opened.result.sessionId;
  const unknownOpen = await request('Grais.relay.openSession', { browserId: 'missing-profile' });
  assert.ok(unknownOpen.error);
  for (const invalidTarget of [{ tabId: 0 }, { tabRef: 'invalid-ref' }]) {
    const invalidOpen = await request('Grais.relay.openSession', {
      browserId: 'brave-profile', ...invalidTarget,
    });
    assert.ok(invalidOpen.error, 'an invalid tab selector is not a browser-only session');
    const invalidCreate = await request('forwardCDPCommand', {
      relaySessionId: sessionId, browserId: 'brave-profile', ...invalidTarget,
      method: 'Target.createTarget', params: { url: 'about:blank' },
    });
    assert.ok(invalidCreate.error, 'an invalid tab selector is not lease-free creation');
  }
  const ambiguous = await request('forwardCDPCommand', {
    relaySessionId: sessionId, method: 'Target.createTarget', params: { url: 'about:blank' },
  });
  assert.match(ambiguous.error, /Multiple browsers/);
  const missing = await request('forwardCDPCommand', {
    relaySessionId: sessionId, browserId: 'missing-profile',
    method: 'Target.createTarget', params: { url: 'about:blank' },
  });
  assert.match(missing.error, /not connected/);
  const unleased = await request('forwardCDPCommand', {
    relaySessionId: sessionId, browserId: 'brave-profile',
    method: 'Runtime.evaluate', params: { expression: 'document.title' },
  });
  assert.ok(unleased.error, 'ordinary commands must still require a tab lease');
  const forwarded = waitForSocketJson(browsers['brave-profile'], (payload) => payload.method === 'forwardCDPCommand');
  const created = request('forwardCDPCommand', {
    relaySessionId: sessionId, browserId: 'brave-profile',
    method: 'Target.createTarget', params: { url: 'about:blank' },
  });
  const command = await forwarded;
  assert.equal(command.params.method, 'Target.createTarget');
  browsers['brave-profile'].send(JSON.stringify({ id: command.id, result: { tabId: 303 } }));
  assert.equal((await created).result.leasedTabRef, 'brave-profile:303');
});

test('first-tab creation preserves session ownership and never substitutes a disconnected browser', async (t) => {
  const { browsers, controller, request, host, port } = await startCreationFixture(t);
  const creation = { browserId: 'brave-profile', method: 'Target.createTarget', params: { url: 'about:blank' } };
  const noSession = await request('forwardCDPCommand', creation);
  assert.match(noSession.error, /requires an active relay session/);
  const unknownSession = await request('forwardCDPCommand', { ...creation, relaySessionId: 'unknown-session' });
  assert.match(unknownSession.error, /Unknown relay session/);
  const opened = await request('Grais.relay.openSession', { client: 'test' });
  const sessionId = opened.result.sessionId;
  const otherController = await connectController(host, port);
  t.after(() => closeSocket(otherController));
  const wrongOwner = waitForSocketJson(otherController, (payload) => payload.id === 1);
  sendRequest(otherController, 1, 'forwardCDPCommand', { ...creation, relaySessionId: sessionId });
  assert.match((await wrongOwner).error, /owned by a different controller/);

  const disconnected = waitForSocketJson(controller, (payload) => payload.params?.type === 'extension_browser_disconnected');
  await closeSocket(browsers['brave-profile']);
  await disconnected;
  let remainingBrowserCommands = 0;
  browsers['chrome-profile'].on('message', (raw) => {
    if (JSON.parse(String(raw)).method === 'forwardCDPCommand') remainingBrowserCommands += 1;
  });
  const unavailable = await request('forwardCDPCommand', { ...creation, relaySessionId: sessionId });
  assert.match(unavailable.error, /not connected/);
  assert.equal(remainingBrowserCommands, 0);

  // The original unselected single-browser flow remains available.
  browsers['chrome-profile'].once('message', (raw) => {
    const command = JSON.parse(String(raw));
    browsers['chrome-profile'].send(JSON.stringify({ id: command.id, result: { tabId: 404 } }));
  });
  const singleBrowser = await request('forwardCDPCommand', {
    relaySessionId: sessionId, method: 'Target.createTarget', params: { url: 'about:blank' },
  });
  assert.equal(singleBrowser.result.leasedTabRef, 'chrome-profile:404');
  assert.equal(remainingBrowserCommands, 1);
});
