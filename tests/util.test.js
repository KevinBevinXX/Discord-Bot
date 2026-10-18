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
/* The welcome greeting should end on its own words: Discord renders the footer
 * text and the timestamp as one line, so dropping the footer has to drop the
 * timestamp with it. */
const theme = require('../src/theme');

test('theme.embed: footer false removes the whole footer line', () => {
  const e = theme.embed(null, { description: 'hi', footer: false }).toJSON();
  assert.equal(e.footer, undefined, 'no footer text');
  assert.equal(e.timestamp, undefined, 'and no timestamp beside it');
});

test('theme.embed: every other embed keeps the brand footer and timestamp', () => {
  const branded = theme.embed(null, { description: 'hi' }).toJSON();
  assert.match(branded.footer.text, /KBX Community Bot/);
  assert.ok(branded.timestamp, 'timestamp still there');
  const withText = theme.embed(null, { description: 'hi', footer: 'Tickets' }).toJSON();
  assert.equal(withText.footer.text, 'KBX Community Bot · Tickets');
});
