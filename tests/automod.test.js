const test = require('node:test');
const assert = require('node:assert');
const am = require('../src/features/automod');

test('normalise catches 1337 speak and padding', () => {
  assert.equal(am.normalizeText('N0ce!'), 'noce');
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

