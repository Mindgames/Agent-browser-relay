const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the generated production extractor without starting the CLI or a browser.
const source = fs.readFileSync(path.join(__dirname, '../scripts/read-active-tab.js'), 'utf8');
const start = source.indexOf('function buildBridgeExpression(config)');
const end = source.indexOf('function defaultExpression(config)', start);
assert.ok(start >= 0 && end > start, 'production expression builders must be present');
const buildExpression = vm.runInNewContext(source.slice(start, end) + '\n; buildBridgeExpression', {
  DEFAULT_PRESET: 'default',
  PRESET_WHATSAPP_MESSAGES: 'whatsapp-messages',
  PRESET_CHAT_AUDIT: 'chat-audit',
  DEFAULT_MESSAGE_MAX_MESSAGES: 500,
});

class Element {
  constructor(text, sender = '', senderNode = '') {
    Object.assign(this, { textContent: text, sender, senderNode, tagName: 'DIV', className: 'message-out' });
    this.classList = ['message-out'];
  }

  getAttribute(name) { return name === 'data-sender' ? this.sender : null; }
  querySelectorAll(selector) {
    return selector.includes('sender') && this.senderNode ? [{ textContent: this.senderNode }] : [];
  }
  cloneNode() { return new Element(this.textContent); }
}

function extract(preset, nodes, config = {}) {
  const root = { querySelectorAll: selector => selector === '[data-testid="message-body"]' ? nodes : [] };
  const document = { body: root, title: 'Synthetic chat', querySelector: () => root, querySelectorAll: () => [] };
  return JSON.parse(JSON.stringify(vm.runInNewContext(buildExpression({ preset, ...config }), {
    Element, document, location: { href: 'https://example.test/chat' },
  })));
}

const regex = pattern => ({ pattern, flags: 'i' });

for (const preset of ['chat-audit', 'chat']) {
  test(`${preset}: retains messages without sender metadata by default`, () => {
    const result = extract(preset, [new Element('Outgoing reply'), new Element('Incoming reply', 'Sam')]);
    assert.deepEqual(result.messages.map(({ text, sender }) => ({ text, sender })), [
      { text: 'Outgoing reply', sender: '' }, { text: 'Incoming reply', sender: 'Sam' },
    ]);
    assert.equal(result.messages[0].direction, 'outgoing');
    assert.equal(result.messages[0].preview, 'Outgoing reply');
    assert.equal(result.totals.filteredBySender, 0);
    assert.equal(result.totals.returned, 2);
  });

  test(`${preset}: treats whitespace-only sender metadata as unknown`, () => {
    const result = extract(preset, [new Element('A reply', ' \t ')]);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].sender, '');
    assert.equal(result.totals.filteredBySender, 0);
  });

  test(`${preset}: exclusion-only filters retain unknown senders`, () => {
    const result = extract(preset, [
      new Element('Unknown sender'), new Element('From Sam', 'Sam'), new Element('From Pat', 'Pat'),
    ], { excludeSenderRegex: regex('^sam$') });
    assert.deepEqual(result.messages.map(message => message.text), ['Unknown sender', 'From Pat']);
    assert.equal(result.totals.filteredBySender, 1);
  });

  test(`${preset}: a catch-all sender exclusion still requires sender metadata`, () => {
    const result = extract(preset, [new Element('Unknown sender'), new Element('From Sam', 'Sam')], {
      excludeSenderRegex: regex('.*'),
    });
    assert.deepEqual(result.messages.map(message => message.text), ['Unknown sender']);
    assert.equal(result.totals.filteredBySender, 1);
  });

  for (const pattern of ['^sam$', '.*', '^$']) {
    test(`${preset}: explicit sender inclusion ${pattern} rejects unknown senders`, () => {
      const result = extract(preset, [new Element('Unknown sender'), new Element('From Sam', 'Sam')], {
        senderRegex: regex(pattern),
      });
      assert.deepEqual(result.messages.map(message => message.text), pattern === '^$' ? [] : ['From Sam']);
      assert.equal(result.totals.filteredBySender, pattern === '^$' ? 2 : 1);
    });
  }

  test(`${preset}: sender exclusions override inclusions and preserve sender-node extraction`, () => {
    const result = extract(preset, [
      new Element('Unknown sender'), new Element('From Sam', '', ' Sam '), new Element('From Pat', '', 'Pat'),
    ], { senderRegex: regex('sam|pat'), excludeSenderRegex: regex('sam') });
    assert.deepEqual(result.messages.map(message => message.sender), ['Pat']);
    assert.equal(result.totals.filteredBySender, 2);
  });

  test(`${preset}: unknown-sender messages still respect text and message filters`, () => {
    const result = extract(preset, [
      new Element('keep one'), new Element('drop text'), new Element('keep blocked'), new Element('keep two'),
    ], { textRegex: regex('^keep'), excludeMessageRegex: regex('blocked') });
    assert.deepEqual(result.messages.map(message => message.text), ['keep one', 'keep two']);
    assert.equal(result.totals.filteredByText, 1);
    assert.equal(result.totals.filteredByMessage, 1);
    assert.equal(result.totals.filteredBySender, 0);
  });

  test(`${preset}: unknown senders respect message limits and existing deduplication`, () => {
    const result = extract(preset, [
      new Element('First'), new Element('First'), new Element('Second'), new Element('Third'),
    ], { maxMessages: 2 });
    assert.deepEqual(result.messages.map(message => message.text), ['First', 'Second']);
    assert.equal(result.totals.returned, 2);
    assert.equal(result.totals.matchedBySelector, 3);
    assert.equal(result.totals.filteredBySender, 0);
  });

  test(`${preset}: still ignores empty message bodies`, () => {
    const result = extract(preset, [new Element(' \n\t '), new Element('Actual reply')]);
    assert.deepEqual(result.messages.map(message => message.text), ['Actual reply']);
    assert.equal(result.totals.matchedBySelector, 1);
  });
}
