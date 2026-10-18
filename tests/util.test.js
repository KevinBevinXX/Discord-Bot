const test = require('node:test');
const assert = require('node:assert');
const { emojiKey, parseEmoji, toReact, displayEmoji, fill, isSnowflake, bar } = require('../src/util');

test('parseEmoji handles every format we accept', () => {
  assert.deepEqual(parseEmoji('🎮'), { name: '🎮', id: undefined, animated: false });
  assert.deepEqual(parseEmoji('<:blobreach:123456789012345678>'), { name: 'blobreach', id: '123456789012345678', animated: false });
  assert.deepEqual(parseEmoji('<a:spin:123456789012345678>'), { name: 'spin', id: '123456789012345678', animated: true });
  assert.deepEqual(parseEmoji('blobreach:123456789012345678'), { name: 'blobreach', id: '123456789012345678', animated: false });
  assert.deepEqual(parseEmoji(':blobreach:123456789012345678'), { name: 'blobreach', id: '123456789012345678', animated: false });
  assert.equal(parseEmoji(''), null);
  assert.equal(parseEmoji(null), null);
});

test('emojiKey unifies equivalence classes (fe0f, custom vs name:id)', () => {
  assert.equal(emojiKey('🎮'), emojiKey({ name: '🎮' }));
  assert.equal(emojiKey('\u2714\uFE0F'), emojiKey('\u2714')); // FE0F variants collide
  assert.equal(emojiKey('<:blobreach:123456789012345678>'), emojiKey('blobreach:123456789012345678'));
  assert.notEqual(emojiKey('🎮'), emojiKey('<:blobreach:123456789012345678>'));
});

test('toReact + displayEmoji round trips', () => {
  assert.equal(toReact('🎮'), '🎮');
  assert.equal(toReact('<:blobreach:123456789012345678>'), 'blobreach:123456789012345678');
  assert.equal(toReact({ name: 'spin', id: '123456789012345678', animated: true }), 'a:spin:123456789012345678');
  assert.equal(displayEmoji({ name: 'blobreach', id: '123456789012345678' }), '<:blobreach:123456789012345678>');
  assert.equal(displayEmoji('🎉'), '🎉');
});

test('fill replaces known placeholders but keeps unknown ones', () => {
  assert.equal(fill('Hi {user} of {server}, lvl {level}!', { user: '<@1>', server: 'Modded', level: 7 }), 'Hi <@1> of Modded, lvl 7!');
  assert.equal(fill('{missing} stays', {}), '{missing} stays');
  assert.equal(fill('n {memberCount}', { memberCount: 0 }), 'n 0');
});

test('snowflakes + bar', () => {
  assert.equal(isSnowflake('123456789012345678'), true);
  assert.equal(isSnowflake('123'), false);
  assert.equal(isSnowflake(''), false);
  assert.equal(bar(0, 100), '░░░░░░░░░░');
  assert.equal(bar(100, 100), '██████████');
  assert.equal(bar(50, 100), '█████░░░░░');
});
/* Every embed ends on its own words: no "KBX Community Bot · X • <time>" line
 * under any message. */
const theme = require('../src/theme');

test('theme.embed carries no footer and no timestamp', () => {
  const e = theme.embed(null, { title: 'Ticket Closed', description: 'hi' }).toJSON();
  assert.equal(e.footer, undefined, 'no footer line');
  assert.equal(e.timestamp, undefined, 'no timestamp beside it');
  assert.equal(e.title, 'Ticket Closed', 'the rest of the embed is untouched');
});

test('a stray footer argument cannot bring the line back', () => {
  const e = theme.embed(null, { description: 'hi', footer: 'Tickets' }).toJSON();
  assert.equal(e.footer, undefined);
});
