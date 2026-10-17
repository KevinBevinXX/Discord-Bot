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
