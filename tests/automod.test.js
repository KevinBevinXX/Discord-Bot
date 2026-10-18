const test = require('node:test');
const assert = require('node:assert');
const am = require('../src/features/automod');

test('normalise catches 1337 speak and padding', () => {
  assert.equal(am.normalizeText('N0ce!'), 'nocei'); // '!' folds to 'i' so "b!tch" reads as "bitch"
  assert.equal(am.normalizeText('b@d w0rds'), 'bad words');
  assert.equal(am.normalizeText('c.o.m'), 'c o m');
  assert.equal(am.normalizeText('héllo'), 'hello');
});

test('banned words match leet variants, not innocent words', () => {
  const list = ['grape'];
  assert.equal(am.checkBannedWords('linux', list), null);
  assert.equal(am.checkBannedWords('the grapes', list), null); // partial words don't match
  assert.equal(am.checkBannedWords('GRAPE', list), 'grape');
  assert.equal(am.checkBannedWords('gr   ape', list), 'grape'); // spaced-letter evasion is compacted
  assert.equal(am.checkBannedWords('6r4pe juice', list), 'grape'); // leet: 6→g, 4→a
});

test('spam detector sliding window', () => {
  const t = new am.SpamTracker();
  assert.equal(t.isSpam('u1', 0, 5, 3), false);
  assert.equal(t.isSpam('u1', 1000, 5, 3), false);
  assert.equal(t.isSpam('u1', 2000, 5, 3), true);   // 3rd message inside 5s
  assert.equal(t.isSpam('u1', 6000, 5, 3), true);   // 1000+2000 still inside the window at 6s
  assert.equal(t.isSpam('u1', 12000, 5, 3), false); // older hits slid out
  assert.equal(t.isSpam('u2', 9000000, 5, 3), false); // other users are isolated
});

test('banned word list works with a real entry and leet obfuscation', () => {
  const list = ['noce'];
  assert.equal(am.checkBannedWords('n0ce', list), 'noce');
  assert.equal(am.checkBannedWords('N O C E', list), 'noce');
  assert.equal(am.checkBannedWords('nice', list), null);
});

test('invite filtering with allowlist', () => {
  assert.equal(am.checkInvites('join discord.gg/abc123'), 'discord.gg/abc123');
  assert.equal(am.checkInvites('join discord.gg/abc123', ['abc123']), null);
  assert.equal(am.checkInvites('join discord.gg/xyz789', ['abc123']), 'discord.gg/xyz789');
  assert.equal(am.checkInvites('no invite here'), null);
  assert.equal(am.checkInvites('https://discord.com/invite/FriendlyCode', []), 'discord.com/invite/FriendlyCode');
});

test('link filtering with domain allowlist, subdomains included', () => {
  assert.equal(am.checkLinks('watch https://youtube.com/watch?v=x'), 'https://youtube.com/watch?v=x');
  assert.equal(am.checkLinks('watch https://youtube.com/watch?v=x', ['youtube.com']), null);
  assert.equal(am.checkLinks('https://music.youtube.com/x', ['youtube.com']), null);
  assert.equal(am.checkLinks('visit example.com or bit.ly/x'), 'example.com');
  assert.equal(am.checkLinks('plain text'), null);
  assert.equal(am.checkLinks('https://youtube.com ok https://evil.com', ['youtube.com']), 'https://evil.com');
});

test('caps detection only for long messages', () => {
  assert.equal(am.checkCaps('HI', 12, 70), null);
  assert.ok(am.checkCaps('THIS IS MOSTLY CAPS TEXT', 12, 70));
  assert.equal(am.checkCaps('mostly this is fine text', 12, 70), null);
});

test('emoji spam count incl. custom emojis', () => {
  assert.equal(am.checkEmojis('hello', 8), null);
  assert.ok(am.checkEmojis('🎉🎉🎉🎉🎉🎉🎉🎉🎉', 8));
  assert.ok(am.checkEmojis('<:blobreach:123456789012345678>'.repeat(9), 8));
});

test('mention check counts users only', () => {
  const mk = (n) => ({ mentions: { users: { filter: (fn) => Array.from({ length: n }, (_, i) => ({ id: `u${i}` })).filter(fn) } }, author: { id: 'me' } });
  const m = mk(9);
  assert.ok(am.checkMentions(m, 5));
  assert.equal(am.checkMentions(mk(3), 5), null);
});


/**
 * Evasion vs false positives — the two failure modes of a word filter, and
 * they pull against each other. Folding doubled letters caught "biitch" but
 * made "as soon as possible" read as a banned "ass", so only runs of THREE
 * or more collapse. These cases pin that line down.
 */
const EVASIONS = [
  ['b1tch', 'bitch'], ['b!tch', 'bitch'], ['biiitch', 'bitch'], ['b i t c h', 'bitch'],
  ['Ьitch', 'bitch'], ['B.I.T.C.H', 'bitch'], ['fuuuck', 'fuck'], ['f u c k', 'fuck'],
  ['@ss', 'ass'], ['a$$', 'ass'], ['sh1t', 'shit'],
];

test('the filter sees through leetspeak, spacing, repeats and lookalike letters', () => {
  const words = ['bitch', 'fuck', 'ass', 'shit'];
  for (const [attempt, base] of EVASIONS) {
    assert.ok(am.checkBannedWords(attempt, words), `"${attempt}" should be caught as "${base}"`);
  }
});

test('ordinary English is left alone', () => {
  const words = ['ass', 'hell', 'bitch', 'fuck'];
  for (const sentence of [
    'I did as you asked', 'as soon as possible', 'he fell down the shell path',
    'class assassin', 'pass the bass', 'hel lo', 'assess the situation',
  ]) {
    assert.equal(am.checkBannedWords(sentence, words), null, `"${sentence}" must not be caught`);
  }
});

test('a self-censored word is not treated as a violation', () => {
  // "f*ck" loses its vowel entirely — the member censored themselves, and the
  // filter does not punish that. Flip this expectation if the policy changes.
  assert.equal(am.checkBannedWords('f*ck', ['fuck']), null);
});

/* Warning roles: the member holds the highest tier reached, and only that one. */
test('pickStrikeRole climbs the ladder and keeps one role', () => {
  const tiers = [
    { strikes: 2, roleId: 'two' }, { strikes: 4, roleId: 'four' }, { strikes: 6, roleId: 'six' },
  ];
  assert.deepEqual(am.pickStrikeRole(tiers, 1), { add: null, remove: ['two', 'four', 'six'] });
  assert.deepEqual(am.pickStrikeRole(tiers, 2), { add: 'two', remove: ['four', 'six'] });
  assert.deepEqual(am.pickStrikeRole(tiers, 5), { add: 'four', remove: ['two', 'six'] });
  assert.deepEqual(am.pickStrikeRole(tiers, 99), { add: 'six', remove: ['two', 'four'] });
});

test('pickStrikeRole: out-of-order and incomplete tiers do not break it', () => {
  const tiers = [{ strikes: 6, roleId: 'six' }, { roleId: 'nostrikes' }, { strikes: 1, roleId: 'one' }, { strikes: 3 }];
  assert.deepEqual(am.pickStrikeRole(tiers, 1), { add: 'one', remove: ['six'] });
  assert.deepEqual(am.pickStrikeRole([], 5), { add: null, remove: [] });
  assert.deepEqual(am.pickStrikeRole(undefined, 5), { add: null, remove: [] });
});

/* The starter list must stay in base form: normalisation already covers the
 * variants, so a "b1tch" entry would be dead weight and a second "bitch" a
 * duplicate. This test is what keeps the file honest as it grows. */
test('the starter word list is base-form and free of duplicates', () => {
  const { starterWords } = require('../tools/merge-wordlist');
  const words = starterWords();
  assert.ok(words.length > 100, `expected a real list, got ${words.length}`);
  const seen = new Map();
  for (const w of words) {
    const n = am.normalizeText(w);
    assert.ok(n, `"${w}" normalises to nothing`);
    assert.equal(seen.has(n), false, `"${w}" duplicates "${seen.get(n)}" once normalised`);
    seen.set(n, w);
  }
});

test('merging keeps what is already configured and drops covered variants', () => {
  const { merge } = require('../tools/merge-wordlist');
  const r = merge(['mykeyword', 'bitch'], ['b1tch', 'fuck', 'bitch']);
  assert.deepEqual(r.words, ['mykeyword', 'bitch', 'fuck'], 'b1tch is already covered by bitch');
});
