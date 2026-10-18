const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/schema');

test('defaults are complete for every feature', () => {
  const d = S.defaults();
  for (const f of S.FEATURES) assert.ok(f.key in d, f.key);
  assert.equal(d.tickets.enabled, true);
  assert.equal(d.tickets.maxOpenPerUser, 1);
  assert.equal(d.levels.xpGrowth, 1.4);
  assert.deepEqual(d.automod.bannedWords.words, []);
  assert.equal(d.reactionRoles.removeOnUnreact, true);
});

test('validate fills missing sections from defaults', () => {
  const r = S.validate({});
  assert.equal(r.ok, true);
  assert.equal(r.config.welcome.welcomeMessage.includes('{user}'), true);
});

test('validate drops unknown keys', () => {
  const r = S.validate({ unknownNonsense: 1, levels: { xpMin: 7, evil: true } });
  assert.equal('unknownNonsense' in r.config, false);
  assert.equal('evil' in r.config.levels, false);
  assert.equal(r.config.levels.xpMin, 7);
});

test('numbers are clamped to schema bounds', () => {
  const r = S.validate({ levels: { xpMax: 999999, maxLevel: 0, xpGrowth: 6 } });
  assert.equal(r.config.levels.xpMax, 1000);
  assert.equal(r.config.levels.maxLevel, 1);
  assert.equal(r.config.levels.xpGrowth, 3);
});

test('channel/role mentions and comma blobs are accepted', () => {
  const r = S.validate({
    tickets: { claimRoleIds: '<@&123456789012345678>' },
    levels: { noXpChannelIds: '111111111111111111,222222222222222222' },
  });
  assert.deepEqual(r.config.tickets.claimRoleIds, ['123456789012345678']);
  assert.deepEqual(r.config.levels.noXpChannelIds, ['111111111111111111', '222222222222222222']);
});

test('garbage IDs are rejected', () => {
  const r = S.validate({ tickets: { claimRoleIds: 'https://evil.test/?x=123456789012345678' } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.config.tickets.claimRoleIds, []); // default kept
});

test('list subfields: required enforced, missing optional fields default', () => {
  const r = S.validate({ tickets: { reasons: [
    { label: 'Hello' },                       // ok, description/emoji default
    {},                                       // invalid, dropped
    { label: 'ok', pingRoleIds: 'notAnId' },  // invalid field → dropped
  ] } });
  assert.equal(r.ok, false);
  assert.equal(r.config.tickets.reasons.length, 1);
  assert.deepEqual(r.config.tickets.reasons[0], { label: 'Hello', description: '', emoji: '', pingRoleIds: [], greeting: '' });
});

test('action + select enums validated', () => {
  const r = S.validate({ automod: { bannedWords: { action: 'nuke' } }, levels: { rewardMode: 'hunt' } });
  assert.equal(r.ok, false);
  assert.equal(r.config.automod.bannedWords.action, 'delete+warn');
  assert.equal(r.config.levels.rewardMode, 'stack');
});

test('wordlist splits lines and rejects 500+ entries silently clamped', () => {
  const words = Array.from({ length: 600 }, (_, i) => `w${i}`);
  const r = S.validate({ automod: { bannedWords: { words } } });
  assert.equal(r.config.automod.bannedWords.words.length, 500);
});

test('colour validation', () => {
  const r = S.validate({ tickets: { panelColor: '#5865F2' } });
  assert.equal(r.config.tickets.panelColor, '#5865F2');
  const bad = S.validate({ tickets: { panelColor: 'red' } });
  assert.equal(bad.ok, false);
});

test('level curve math', () => {
  // base 100, growth 1.4: costs 100, 140, 196, ...
  assert.equal(S.costToNext(0, 100, 1.4), 100);
  assert.equal(S.costToNext(1, 100, 1.4), 140);
  assert.equal(S.totalXpForLevel(3, 100, 1.4), 100 + 140 + 196);
  assert.equal(S.levelFromTotalXp((100 + 140 + 196 + 274) * 0, 100, 1.4, 100), 0); // counting exactness below
  // exactly 436 xp => level 3
  assert.equal(S.levelFromTotalXp(436, 100, 1.4, 100), 3);
  // max level clamps
  assert.equal(S.levelFromTotalXp(1e9, 100, 1.4, 5), 5);
});

test('ARCADE-like curve: xpGrowth 1 stays linear', () => {
  assert.equal(S.costToNext(7, 50, 1), 50);
  assert.equal(S.totalXpForLevel(4, 50, 1), 200);
});