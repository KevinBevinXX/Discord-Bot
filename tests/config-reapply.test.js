/**
 * The re-apply decision: a save that changes no setting must still re-apply.
 *
 * Why this exists: the GitHub Contents API `sha` is the BLOB sha
 * (git hash-object of the content), so re-saving an identical config.json
 * produces the same sha and the same validated JSON. The bot therefore saw
 * nothing to do, and a ticket panel someone deleted in Discord was never
 * re-posted. The dashboard now stamps `savedAt` on every save and the poller
 * compares the raw file, so any save re-applies the features.
 */
const test = require('node:test');
const assert = require('node:assert');
const configModule = require('../src/config');

function configText(savedAt) {
  return JSON.stringify({
    general: { guildId: '123456789012345678' },
    tickets: { enabled: true, panelChannelId: '234567890123456789' },
    ...(savedAt ? { savedAt } : {}),
  }, null, 2);
}

test('unchanged polls do not re-apply, a re-save does', () => {
  const applied = [];
  configModule.onConfigApplied((cfg, meta) => applied.push(meta));

  const first = configText('2026-10-17T00:00:00.000Z');
  assert.equal(configModule.__readTest(first, 'test'), true);
  assert.equal(applied.length, 1, 'the first load applies');
  assert.equal(applied[0].first, true, 'and is flagged as the first apply');

  // the 20s poll with nothing new in the file
  configModule.__readTest(first, 'test');
  configModule.__readTest(first, 'test');
  assert.equal(applied.length, 1, 'an unchanged file must not re-apply');

  // same settings, new stamp — exactly what a dashboard save now commits
  configModule.__readTest(configText('2026-10-17T00:05:00.000Z'), 'test');
  assert.equal(applied.length, 2, 'a re-save must re-apply so deleted panels come back');
  assert.equal(applied[1].first, false, 'and is not the first apply');

  // a real settings change still applies
  const changed = JSON.parse(configText('2026-10-17T00:05:00.000Z'));
  changed.tickets.panelTitle = 'Need a hand?';
  configModule.__readTest(JSON.stringify(changed, null, 2), 'test');
  assert.equal(applied.length, 3, 'a content change applies');
  assert.equal(configModule.get().tickets.panelTitle, 'Need a hand?');
});

test('the stamp is not a setting — validate() drops it', () => {
  configModule.__readTest(configText('2026-10-17T01:00:00.000Z'), 'test');
  assert.equal(configModule.get().savedAt, undefined, 'savedAt must never reach the live config');
});
