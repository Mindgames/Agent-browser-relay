const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Load only the production expression builder, without initializing the CLI's
// WebSocket connection or touching an installed extension.
const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'read-active-tab.js'), 'utf8');
const builderStart = source.indexOf('function buildWhatsAppMessagesExpression(config) {');
const builderEnd = source.indexOf('\nfunction buildChatAuditExpression(config) {', builderStart);
assert.ok(builderStart >= 0 && builderEnd > builderStart, 'WhatsApp expression builder must be present');
const buildExpression = vm.runInNewContext(
  source.slice(builderStart, builderEnd) + '\nbuildWhatsAppMessagesExpression',
  { DEFAULT_MESSAGE_MAX_MESSAGES: 200 },
);

const nodePositions = {
  DOCUMENT_POSITION_DISCONNECTED: 1,
  DOCUMENT_POSITION_PRECEDING: 2,
  DOCUMENT_POSITION_FOLLOWING: 4,
};

// A small synthetic DOM implements the APIs the generated extractor uses.
// Query results follow document order; different selectors deliberately overlap.
class FixtureElement {
  constructor({ position, selectors = [], attributes = {}, text = '' }) {
    this.position = position;
    this.selectors = new Set(selectors);
    this.attributes = attributes;
    this.textContent = text;
    this.children = [];
    this.parent = null;
    this.classList = { contains: (name) => this.selectors.has('.' + name) };
  }

  append(child) {
    child.parent = this;
    this.children.push(child);
  }

  matches(selector) {
    return selector.split(',').some((part) => this.selectors.has(part.trim()));
  }

  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  querySelectorAll(selector) {
    const results = [];
    for (const child of this.children) {
      if (child.matches(selector)) results.push(child);
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  cloneNode() {
    return new FixtureElement({
      position: this.position,
      selectors: [...this.selectors],
      attributes: { ...this.attributes },
      text: this.textContent,
    });
  }

  compareDocumentPosition(other) {
    if (this === other) return 0;
    return this.position < other.position
      ? nodePositions.DOCUMENT_POSITION_FOLLOWING
      : nodePositions.DOCUMENT_POSITION_PRECEDING;
  }
}

function extract(messages, config = {}) {
  const root = new FixtureElement({ position: -1 });
  let scope = null;
  for (const [index, message] of messages.entries()) {
    const direction = message.outgoing ? 'message-out' : 'message-in';
    const wrapper = new FixtureElement({
      position: index * 2,
      selectors: ['.' + direction, '[data-id]', ...(message.nestedRow ? [] : ['[role="row"]'])],
      attributes: { 'data-id': message.id },
    });
    const copyable = new FixtureElement({
      position: index * 2 + 1,
      selectors: ['.copyable-text', '.copyable-text[data-pre-plain-text]', '[data-pre-plain-text]'],
      attributes: {
        // Identical times ensure the fix uses actual DOM order, not timestamps.
        'data-pre-plain-text': '[10:00 AM, 10/12/2026] ' + (message.sender || 'Alice') + ': ',
      },
      text: message.text || message.id,
    });
    wrapper.append(copyable);
    let row = wrapper;
    if (message.nestedRow) {
      row = new FixtureElement({ position: index * 2 - 0.25, selectors: ['[role="row"]'] });
      row.append(wrapper);
    }
    if (message.inScope) {
      if (!scope) {
        scope = new FixtureElement({ position: index * 2 - 0.5, selectors: ['#selected'] });
        root.append(scope);
      }
      scope.append(row);
    } else {
      root.append(row);
    }
  }

  const document = {
    body: root,
    querySelector: (selector) => selector === '#selected' ? scope : root,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
  };
  const result = vm.runInNewContext(buildExpression(config), {
    document,
    Element: FixtureElement,
    HTMLElement: FixtureElement,
    Node: nodePositions,
  });
  return JSON.parse(JSON.stringify(result));
}

function ids(result) {
  assert.equal(result.count, result.messages.length);
  return result.messages.map((message) => message.messageId);
}

const interleaved = [
  { id: 'question', outgoing: false },
  { id: 'answer', outgoing: true },
  { id: 'thanks', outgoing: false },
  { id: 'welcome', outgoing: true },
];

test('WhatsApp messages preserve interleaved incoming and outgoing DOM order', () => {
  const result = extract(interleaved);
  assert.deepEqual(ids(result), ['question', 'answer', 'thanks', 'welcome']);
  assert.deepEqual(result.messages.map((message) => message.isOutgoing), [false, true, false, true]);
});

test('WhatsApp messages preserve an outgoing-first conversation', () => {
  const messages = [
    { id: 'sent-first', outgoing: true },
    { id: 'received-next', outgoing: false },
    { id: 'sent-last', outgoing: true },
  ];
  assert.deepEqual(ids(extract(messages)), ['sent-first', 'received-next', 'sent-last']);
});

test('overlapping wrapper and copyable selectors do not duplicate messages', () => {
  const result = extract(interleaved);
  assert.equal(result.count, 4);
  assert.equal(new Set(ids(result)).size, 4);
  assert.deepEqual(result.messages.map((message) => message.message).sort(), ['answer', 'question', 'thanks', 'welcome']);
});

test('max-messages limits the ordered conversation rather than one direction', () => {
  assert.deepEqual(ids(extract(interleaved, { maxMessages: 2 })), ['question', 'answer']);
  assert.deepEqual(
    ids(extract([{ id: 'first', outgoing: true }, { id: 'second', outgoing: false }], { maxMessages: 1 })),
    ['first'],
  );
});

test('message filtering happens before the ordered result limit', () => {
  const messages = [
    { id: 'ignored', outgoing: true, text: 'skip' },
    { id: 'first-match', outgoing: false, text: 'keep first' },
    { id: 'excluded', outgoing: false, text: 'keep excluded' },
    { id: 'second-match', outgoing: true, text: 'keep second' },
    { id: 'later-match', outgoing: false, text: 'keep later' },
  ];
  assert.deepEqual(ids(extract(messages, {
    maxMessages: 2,
    messageRegex: { pattern: '^keep', flags: '' },
    excludeMessageRegex: { pattern: 'excluded', flags: '' },
  })), ['first-match', 'second-match']);
});

test('sender filtering happens before the ordered result limit', () => {
  const messages = [
    { id: 'ignored', outgoing: false, sender: 'Bob' },
    { id: 'first-match', outgoing: true, sender: 'Alice' },
    { id: 'second-match', outgoing: false, sender: 'Alice' },
    { id: 'later-match', outgoing: true, sender: 'Alice' },
  ];
  assert.deepEqual(ids(extract(messages, {
    maxMessages: 2,
    senderRegex: { pattern: '^Alice$', flags: '' },
  })), ['first-match', 'second-match']);
});

test('per-selector document fallback preserves its scope and participates in DOM order', () => {
  const messages = [
    { id: 'fallback-before', outgoing: true },
    { id: 'inside-first', outgoing: false, inScope: true },
    { id: 'inside-second', outgoing: false, inScope: true },
    { id: 'fallback-after', outgoing: true },
  ];
  // The selected subtree has incoming messages only. Preserve the existing
  // outgoing-selector document fallback, ordering both sources before limiting.
  assert.deepEqual(ids(extract(messages, { selector: '#selected' })), [
    'fallback-before', 'inside-first', 'inside-second', 'fallback-after',
  ]);
  assert.deepEqual(ids(extract(messages, { selector: '#selected', maxMessages: 3 })), [
    'fallback-before', 'inside-first', 'inside-second',
  ]);
});

test('empty conversations remain valid', () => {
  assert.deepEqual(ids(extract([])), []);
});

test('limits larger than the result retain every message in DOM order', () => {
  assert.deepEqual(ids(extract(interleaved, { maxMessages: 20 })), ['question', 'answer', 'thanks', 'welcome']);
});

const nested = (messages) => messages.map((message) => ({ ...message, nestedRow: true }));

test('outer rows preserve same-minute message IDs and both directions without duplicates', () => {
  const result = extract(nested(interleaved));
  assert.deepEqual(ids(result), ['question', 'answer', 'thanks', 'welcome']);
  assert.deepEqual(result.messages.map((message) => message.isOutgoing), [false, true, false, true]);
  assert.deepEqual(result.messages.map((message) => message.message), ['question', 'answer', 'thanks', 'welcome']);
});

test('outer rows preserve outgoing-first order before the limit', () => {
  const result = extract(nested([
    { id: 'sent-first', outgoing: true },
    { id: 'received-next', outgoing: false },
    { id: 'sent-last', outgoing: true },
  ]), { maxMessages: 2 });
  assert.deepEqual(ids(result), ['sent-first', 'received-next']);
  assert.deepEqual(result.messages.map((message) => message.isOutgoing), [true, false]);
});

test('nested message filters and exclusions precede the ordered limit', () => {
  const result = extract(nested([
    { id: 'ignored', outgoing: true, text: 'skip' },
    { id: 'first-match', outgoing: false, text: 'keep first' },
    { id: 'excluded', outgoing: false, text: 'keep excluded' },
    { id: 'second-match', outgoing: true, text: 'keep second' },
    { id: 'later-match', outgoing: false, text: 'keep later' },
  ]), {
    maxMessages: 2,
    messageRegex: { pattern: '^keep', flags: '' },
    excludeMessageRegex: { pattern: 'excluded', flags: '' },
  });
  assert.deepEqual(ids(result), ['first-match', 'second-match']);
  assert.deepEqual(result.messages.map((message) => message.isOutgoing), [false, true]);
});

test('nested sender filtering precedes the ordered limit', () => {
  const result = extract(nested([
    { id: 'ignored', outgoing: false, sender: 'Bob' },
    { id: 'first-match', outgoing: true, sender: 'Alice' },
    { id: 'second-match', outgoing: false, sender: 'Alice' },
    { id: 'later-match', outgoing: true, sender: 'Alice' },
  ]), { maxMessages: 2, senderRegex: { pattern: '^Alice$', flags: '' } });
  assert.deepEqual(ids(result), ['first-match', 'second-match']);
  assert.deepEqual(result.messages.map((message) => message.isOutgoing), [true, false]);
});
