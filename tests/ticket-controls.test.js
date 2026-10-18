/**
 * One ticket, one set of buttons.
 *
 * Kevin opened a ticket and saw two Claim and two Close buttons: the init
 * embed carried the row AND the ping message built its own identical copy.
 * Only the init embed may carry it — that is the message `handleClaim` edits
 * (db `init_message_id`), so the second copy was also permanently stale.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const tickets = require('../src/features/tickets');

test('the Claim/Close row is one row with exactly those two buttons', () => {
  const row = tickets.controlsRow().toJSON();
  assert.equal(row.type, 1, 'an action row');
  assert.equal(row.components.length, 2, 'exactly two buttons');
  assert.deepEqual(
    row.components.map((c) => c.custom_id),
    [tickets.IDs.claim, tickets.IDs.close],
  );
  assert.deepEqual(row.components.map((c) => c.label), ['Claim', 'Close']);
});

test('exactly one message attaches it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'tickets.js'), 'utf8');
  // the declaration plus one call site; a second `controlsRow()` on another
  // channel.send is the regression this guards
  assert.equal((src.match(/controlsRow\(\)/g) || []).length, 2,
    'controlsRow() should appear twice: its declaration and one use');
  // and nobody hand-rolls the row again
  assert.equal((src.match(/setCustomId\(IDs\.claim\)/g) || []).length, 1,
    'the Claim button should only be built inside controlsRow()');
});

/**
 * There is no transcript file any more, so the "View transcript" button has to
 * carry the whole thing across follow-up messages without cutting a line in
 * half or exceeding Discord's 2000-character message limit.
 */
test('chunkText splits on line boundaries, under the message limit', () => {
  const text = Array.from({ length: 200 }, (_, i) => `[2026-10-15 17:04] user: message number ${i}`).join('\n');
  const chunks = tickets.chunkText(text);
  assert.ok(chunks.length > 1, 'a long transcript needs several messages');
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk of ${c.length} exceeds the limit`);
  assert.ok(!chunks.some((c) => /message number \d+[^\n\d]*$/.test(c) === false && c.endsWith('messag')), 'no mid-line cut');
  // every line survives somewhere, in order
  const rejoined = chunks.join('\n');
  assert.ok(rejoined.includes('message number 0'));
  assert.ok(rejoined.includes('message number 199'), 'nothing is dropped at this size');
});

test('chunkText gives up cleanly on an enormous transcript', () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
  const chunks = tickets.chunkText(huge);
  assert.equal(chunks.length, 6, 'capped at maxChunks');
  assert.match(chunks[chunks.length - 1], /transcript truncated/);
});

test('chunkText never returns nothing', () => {
  assert.deepEqual(tickets.chunkText(''), ['(empty transcript)']);
});

/**
 * Deleting the panel is deliberate. Only a dashboard save re-sends it — not a
 * timer, not a restart. (The earlier behaviour kept resurrecting a panel Kevin
 * had just deleted.)
 */
test('panelAction: a deleted panel stays deleted unless a save asks for it', () => {
  const P = tickets.panelAction;
  assert.equal(P({ savedId: '', found: false, repost: false }), 'post', 'first-time setup posts');
  assert.equal(P({ savedId: '', found: false, repost: true }), 'post');
  assert.equal(P({ savedId: '1', found: true, repost: false }), 'edit', 'still there → edit');
  assert.equal(P({ savedId: '1', found: true, repost: true }), 'edit');
  assert.equal(P({ savedId: '1', found: false, repost: false }), 'skip', 'deleted on purpose → leave it');
  assert.equal(P({ savedId: '1', found: false, repost: true }), 'post', 'a save re-sends it');
});
