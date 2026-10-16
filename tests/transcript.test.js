const test = require('node:test');
const assert = require('node:assert');
const { buildTranscriptHtml, esc } = require('../src/transcript');

test('esc strips injection vectors', () => {
  assert.equal(esc('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
});

test('transcript html contains the audit trail + escaped content', () => {
  const html = buildTranscriptHtml({
    guild: 'Modded <Server>',
    channel: 'ticket-0007',
    ticketNumber: 7,
    reason: 'Broken mod &>',
    openedBy: '111111111111111111',
    closedBy: 'staff',
    closeReason: 'Fixed by UPDATE2',
    messages: [
      { createdTimestamp: Date.parse('2026-10-15T12:00:00Z'), author: { username: 'opener<b>', bot: false, displayAvatarURL: () => 'https://cdn.example/a.png' }, content: 'hello <world>', attachments: new Map([['1', { name: 'log.txt', url: 'https://cdn.example/log.txt' }]]) },
      { createdTimestamp: Date.parse('2026-10-15T12:01:00Z'), author: { username: 'mod', bot: false, displayAvatarURL: () => 'https://cdn.example/b.png' }, content: '', attachments: new Map() },
    ],
  });
  assert.ok(html.includes('Ticket #7'));
  assert.ok(html.includes('Modded &lt;Server&gt;'));
  assert.ok(html.includes('hello &lt;world&gt;'));
  assert.ok(html.includes('log.txt'));
  assert.ok(html.includes('(no text)'));
  assert.ok(html.includes('Fixed by UPDATE2'));
  assert.ok(html.includes('<a href="https://cdn.example/log.txt">'));
  assert.equal(html.includes(' href="javascript:'), false); // never linkify into javascript:
});