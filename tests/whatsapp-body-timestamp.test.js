const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Execute the production preset dispatcher and generated page expression without
// CLI startup, installed extensions, sockets, or a user's browser.
const source = fs.readFileSync(path.join(__dirname, '../scripts/read-active-tab.js'), 'utf8');
const start = source.indexOf('function buildBridgeExpression(config)');
const end = source.indexOf('function buildChatAuditExpression(config)', start);
assert.ok(start >= 0 && end > start);
const buildExpression = vm.runInNewContext(source.slice(start, end) + '\nbuildBridgeExpression', {
  DEFAULT_PRESET: 'default', PRESET_WHATSAPP_MESSAGES: 'whatsapp-messages',
  PRESET_CHAT_AUDIT: 'chat-audit', DEFAULT_MESSAGE_MAX_MESSAGES: 500,
});

// Synthetic DOM with deep cloning and live textContent aggregation. Removing a
// timestamp from a clone must change its text without mutating the original.
class Element {
  constructor(tagName = 'div', attributes = {}, text = '') {
    Object.assign(this, { tagName, attributes, text, children: [], parent: null });
    this.classList = { contains: name => (this.attributes.class || '').split(' ').includes(name) };
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  append(child) { child.parent = this; this.children.push(child); return child; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value === '*' || value === this.tagName) return true;
      if (value === 'span > span.x3nfvp2') {
        return this.tagName === 'span' && this.classList.contains('x3nfvp2') && this.parent?.tagName === 'span';
      }
      if (value === 'span.x3nfvp2') return this.tagName === 'span' && this.classList.contains('x3nfvp2');
      if (value === '.copyable-text[data-pre-plain-text]') {
        return this.classList.contains('copyable-text') && this.getAttribute('data-pre-plain-text') !== null;
      }
      if (value.startsWith('.')) return this.classList.contains(value.slice(1));
      const attr = value.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      return Boolean(attr && (attr[2] === undefined
        ? this.getAttribute(attr[1]) !== null : this.getAttribute(attr[1]) === attr[2]));
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  cloneNode(deep) {
    const clone = new Element(this.tagName, { ...this.attributes }, this.text);
    if (deep) for (const child of this.children) clone.append(child.cloneNode(true));
    return clone;
  }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  compareDocumentPosition(other) {
    if (this === other) return 0;
    const root = this.closest('body');
    const order = [root, ...root.querySelectorAll('*')];
    return order.indexOf(this) < order.indexOf(other) ? 4 : 2;
  }
}

function extract(body, { badge = '12:00', nestedBadge = true, outgoing = false, quote = false, ...config } = {}) {
  const root = new Element('body');
  const message = root.append(new Element('div', {
    class: outgoing ? 'message-out' : 'message-in', 'data-id': 'synthetic-message',
  }));
  const copyable = message.append(new Element('div', {
    class: 'copyable-text', 'data-pre-plain-text': '[12:00, 10/17/2026] Synthetic Sender: ',
  }));
  if (quote) {
    const quoted = copyable.append(new Element('div', { 'data-testid': 'quoted-message' }));
    quoted.append(new Element('span', { 'data-testid': 'quoted-author' }, 'Quoted Sender'));
    quoted.append(new Element('span', { 'data-testid': 'quoted-text' }, 'Earlier message at 12:00'));
  }
  copyable.append(new Element('span', { class: 'selectable-text' }, body));
  if (badge !== null) {
    const parent = nestedBadge ? copyable.append(new Element('span')) : copyable;
    parent.append(new Element('span', { class: 'x3nfvp2' }, badge));
  }
  const originalText = copyable.textContent;
  const document = { body: root, querySelector: () => root, querySelectorAll: selector => root.querySelectorAll(selector) };
  const result = vm.runInNewContext(buildExpression({ preset: 'whatsapp-messages', ...config }), {
    document, Element, HTMLElement: Element,
    Node: { DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 },
  });
  assert.equal(copyable.textContent, originalText, 'extraction must not mutate the page');
  assert.equal(copyable.querySelectorAll('span.x3nfvp2').length, badge === null ? 0 : 1);
  return JSON.parse(JSON.stringify(result));
}

for (const preset of ['whatsapp-messages', 'whatsapp', 'wa']) {
  for (const outgoing of [false, true]) {
    for (const [body, badge] of [
      ['Meet me at 12:00', '12:00'], ['12:00', '12:00'],
      ['At 1:05 PM', '1:05 PM'], ['At 1:05\u202fPM', '1:05\u202fPM'],
      ['At ١٢:٠٠', '١٢:٠٠'],
    ]) {
      test(`${preset}: preserves ${JSON.stringify(body)} (${outgoing ? 'outgoing' : 'incoming'})`, () => {
        const result = extract(body, { preset, outgoing, badge });
        assert.equal(result.count, 1, 'a body consisting of a time is still a message');
        assert.equal(result.messages[0].message, body);
        assert.equal(result.messages[0].messageId, 'synthetic-message');
        assert.equal(result.messages[0].username, 'Synthetic Sender');
        assert.equal(result.messages[0].time, '12:00');
        assert.equal(result.messages[0].date, '2026-10-17 12:00:00');
        assert.equal(result.messages[0].isOutgoing, outgoing);
      });
    }
  }
}

test('preserves matching body suffix with a direct timestamp span', () => {
  assert.equal(extract('Meet at 12:00', { nestedBadge: false }).messages[0].message, 'Meet at 12:00');
});

test('message inclusion sees the complete body after badge removal', () => {
  assert.equal(extract('Meet at 12:00', { messageRegex: { pattern: '12:00$', flags: '' } }).count, 1);
});

test('message exclusion sees the complete body after badge removal', () => {
  assert.equal(extract('Meet at 12:00', { excludeMessageRegex: { pattern: '12:00$', flags: '' } }).count, 0);
});

test('quoted reply content and matching body suffix are preserved separately', () => {
  const result = extract('Meet at 12:00', { quote: true });
  assert.equal(result.messages[0].message, '<reply author="Quoted Sender">Earlier message at 12:00</reply>\nMeet at 12:00');
});

for (const [body, options, expected] of [
  ['Meet at 13:00', {}, 'Meet at 13:00'],
  ['Meet at 12:00 tomorrow', {}, 'Meet at 12:00 tomorrow'],
  ['  Meet at 12:00  ', {}, 'Meet at 12:00'],
  ['Meet at 12:00', { badge: null }, 'Meet at 12:00'],
  ['Meet at 12:00', { badge: '' }, 'Meet at 12:00'],
]) {
  test(`preserves unaffected body ${JSON.stringify(body)} with ${JSON.stringify(options)}`, () => {
    assert.equal(extract(body, options).messages[0].message, expected);
  });
}

test('a timestamp badge alone does not become a message', () => {
  assert.equal(extract('').count, 0);
});
