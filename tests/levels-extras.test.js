const test = require('node:test');
const assert = require('node:assert');
const levels = require('../src/features/levels');
const am = require('../src/features/automod');

const memberWith = (ids) => ({ roles: { cache: { has: (id) => ids.includes(id) } } });

test('xp multipliers: no list = 1x, holder gets boost, multiple stack additively', () => {
  const L = { xpMultipliers: [{ roleId: 'r1', percent: 150 }, { roleId: 'r2', percent: 200 }] };
  assert.equal(levels.multiplierOf(memberWith([]), L), 1);
  assert.equal(levels.multiplierOf(memberWith(['r1']), L), 1.5);
  assert.equal(levels.multiplierOf(memberWith(['r1', 'r2']), L), 2.5);
  assert.equal(levels.multiplierOf(memberWith(['r1']), {}), 1);
});

test('zero multiplier blocks xp', () => {
  const L = { xpMultipliers: [{ roleId: 'mute', percent: 0 }] };
  assert.equal(levels.multiplierOf(memberWith(['mute']), L), 0);
});

test('duplicate detector: same text inside window hits, outside window and different text do not', () => {
  const now = Date.now();
  assert.equal(am.checkDuplicate('hello world', now - 5000, 'hello world', now, 30), 'hello world');
  assert.equal(am.checkDuplicate('hello world', now - 60000, 'hello world', now, 30), null);
  assert.equal(am.checkDuplicate('hello world', now - 1000, 'other text', now, 30), null);
  assert.equal(am.checkDuplicate(null, 0, 'hello', now, 30), null);
  // leet + spacing variants count as the same message
  assert.equal(am.checkDuplicate('h e l l o', now - 1000, 'hello', now, 30), 'h e l l o');
});
