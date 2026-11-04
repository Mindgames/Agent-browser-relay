const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Evaluate the production expression builder, without the CLI's socket setup.
const source = fs.readFileSync(path.join(__dirname, '../scripts/read-active-tab.js'), 'utf8');
const start = source.indexOf('function buildBridgeExpression(config)');
const end = source.indexOf('function buildChatAuditExpression(config)', start);
assert.ok(start >= 0 && end > start, 'production expression builders must be present');
const buildExpression = vm.runInNewContext(
  source.slice(start, end) + '\n; buildBridgeExpression',
  {
    DEFAULT_PRESET: 'default',
    PRESET_WHATSAPP_MESSAGES: 'whatsapp-messages',
    PRESET_CHAT_AUDIT: 'chat-audit',
    DEFAULT_MESSAGE_MAX_MESSAGES: 500,
  },
);

class Element {
  constructor({ id, header, text, outgoing = false, copyable = false, root = null }) {
    Object.assign(this, { id, header, textContent: text, outgoing, copyable, root });
    this.classList = { contains: name => !copyable && name === (outgoing ? 'message-out' : 'message-in') };
  }

  getAttribute(name) {
    if (name === 'data-pre-plain-text') return this.copyable ? this.header : null;
    if (name === 'data-id') return this.copyable ? null : this.id;
    return null;
  }

  matches(selector) {
    return this.copyable && ['.copyable-text', '.copyable-text[data-pre-plain-text]'].includes(selector);
  }

  querySelector(selector) {
    if (!this.copyable && ['.copyable-text[data-pre-plain-text]', '[data-pre-plain-text]'].includes(selector)) {
      return this.child;
    }
    return null;
  }

  querySelectorAll() { return []; }

  closest(selector) {
    const root = this.root || this;
    if (selector === '.message-out') return root.outgoing ? root : null;
    if (selector === '.message-in') return root.outgoing ? null : root;
    return selector.includes('.message-in') ? root : null;
  }

  cloneNode() {
    return new Element({ id: this.id, header: this.header, text: this.textContent, copyable: this.copyable });
  }
}

function extract(clock, { preset = 'whatsapp-messages', date = '10/16/2026', outgoing = false } = {}) {
  const node = new Element({ id: 'synthetic-message', text: '', outgoing });
  node.child = new Element({
    header: `[${clock}, ${date}] Synthetic Sender: `,
    text: 'Synthetic message body',
    copyable: true,
    root: node,
  });
  const root = {
    querySelectorAll: selector => selector === (outgoing ? '.message-out' : '.message-in') ? [node] : [],
  };
  const document = { querySelector: () => root, querySelectorAll: () => [], body: root };
  const result = vm.runInNewContext(buildExpression({ preset, maxMessages: 10 }), {
    document, Element, HTMLElement: Element,
  });
  assert.equal(result.count, 1);
  const message = result.messages[0];
  assert.equal(message.messageId, 'synthetic-message');
  assert.equal(message.message, 'Synthetic message body');
  assert.equal(message.isOutgoing, outgoing);
  return message;
}

for (const preset of ['whatsapp-messages', 'whatsapp', 'wa']) {
  for (const period of ['AM', 'PM']) {
    for (let hour = 1; hour <= 12; hour += 1) {
      test(`${preset}: converts ${hour}:05 ${period} to a 24-hour timestamp`, () => {
        const expected = String(hour % 12 + (period === 'PM' ? 12 : 0)).padStart(2, '0') + ':05';
        const message = extract(`${hour}:05 ${period}`, { preset, outgoing: period === 'PM' });
        assert.equal(message.username, 'Synthetic Sender');
        assert.equal(message.time, expected);
        assert.equal(message.date, `2026-10-16 ${expected}:00`);
      });
    }
  }
}

for (const [input, expected] of [
  ['1:05pm', '13:05'],
  ['01:05 pM', '13:05'],
  ['12:05 am', '00:05'],
  ['1:05\tPM', '13:05'],
  ['1:05\u00a0PM', '13:05'],
  ['1:05\u202fPM', '13:05'],
  [' 1:05 PM ', '13:05'],
  ['00:05', '00:05'],
  ['0:05', '00:05'],
  ['1:05', '01:05'],
  ['12:05', '12:05'],
  ['13:05', '13:05'],
  ['23:59', '23:59'],
  ['13:05:30', '13:05'],
]) {
  test(`preserves clock formatting for ${JSON.stringify(input)}`, () => {
    const message = extract(input, { date: '10/16/26' });
    assert.equal(message.time, expected);
    assert.equal(message.date, `2026-10-16 ${expected}:00`);
  });
}

for (const input of ['0:05 AM', '13:05 PM', '24:05 AM', 'abc:05 PM']) {
  test(`does not fabricate a timestamp for invalid 12-hour clock ${input}`, () => {
    const message = extract(input);
    assert.equal(message.time, null);
    assert.equal(message.date, null);
    assert.equal(message.username, '');
  });
}
