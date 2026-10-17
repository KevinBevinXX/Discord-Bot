/**
 * The plain-text transcript behind the "View transcript" button.
 *
 * The log channel used to unroll the raw HTML inline; the file now goes up
 * spoilered and this is what the button replies with — readable lines, not
 * markup.
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildTranscriptText } = require('../src/transcript');

const messages = [
  { createdTimestamp: Date.UTC(2026, 9, 15, 17, 4), content: 'hello, my game crashes', author: { username: 'KevinBevinX', bot: false } },
  { createdTimestamp: Date.UTC(2026, 9, 15, 17, 5), content: 'on it', author: { username: 'KBX Community Bot', bot: true } },
  { createdTimestamp: Date.UTC(2026, 9, 15, 17, 6), content: '', author: { username: 'KevinBevinX', bot: false },
    attachments: new Map([['1', { name: 'crash.log' }]]) },
];

test('renders readable lines, no markup', () => {
  const text = buildTranscriptText({
    guild: "KevinBevinX's Community", ticketNumber: 5, reason: 'Report a player',
    openedBy: 'KevinBevinX', closedBy: 'KevinBevinX', closeReason: '', messages,
  });
  const lines = text.split('\n');
  assert.match(lines[0], /^Ticket #5 — Report a player · KevinBevinX's Community$/);
  assert.match(text, /Close reason: No reason specified/);
  assert.match(text, /\[2026-10-15 17:04\] KevinBevinX: hello, my game crashes/);
  assert.match(text, /KBX Community Bot \(bot\): on it/);
  assert.match(text, /\(no text\) \[crash\.log\]/, 'an attachment-only message still shows');
  assert.ok(!/[<>]/.test(text), 'no HTML tags leak into the readable version');
});

test('an empty ticket still produces a header', () => {
  const text = buildTranscriptText({ ticketNumber: 1, messages: [] });
  assert.match(text, /^Ticket #1\n/);
});
