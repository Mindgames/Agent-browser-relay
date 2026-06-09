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
