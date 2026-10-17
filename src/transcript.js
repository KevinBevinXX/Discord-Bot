/**
 * HTML transcript generation for closed tickets. Pure function → tested.
 * Deliberately dependency-free (no canvas, no mustache):inline-styled HTML.
 */

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMessage(m) {
  const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
  const author = esc(`${m.author ? m.author.username : 'unknown'}${m.author && m.author.bot ? ' (bot)' : ''}`);
  let body = esc(m.content);
  // linkify bare URLs that Discord would have auto-embedded
  body = body.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`);
  if (m.attachments && m.attachments.size) {
    const items = [...m.attachments.values()].map((a) => `<a href="${esc(a.url)}">${esc(a.name)}</a>`);
    body += (body ? '\n' : '') + `📎 ${items.join(' · ')}`;
  }
  return `            <div class="msg">
                <div class="head">
                    <img class="avatar" src="${esc(m.author && m.author.displayAvatarURL ? m.author.displayAvatarURL({ size: 32, extension: 'png' }) : '')}" alt="">
                    <span class="author">${author}</span>
                    <span class="time">${when}</span>
                </div>
                <div class="body">${body.replace(/\n/g, '<br>') || '<span class="empty">(no text)</span>'}</div>
            </div>`;
}

function buildTranscriptHtml({ guild, channel, ticketNumber, reason, openedBy, closedBy, closeReason, messages }) {
  const date = new Date().toISOString().slice(0, 10);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ticket #${esc(ticketNumber)} — ${esc(guild)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; background:#1e1f22; color:#dbdee1; margin:0; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px; }
  header { border-bottom: 2px solid #5865F2; margin-bottom: 18px; padding-bottom: 12px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .meta { color: #b5bac1; font-size: 13px; }
  .meta b { color: #dbdee1; }
  .msg { background:#2b2d31; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; }
  .head { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
  .avatar { width:26px; height:26px; border-radius:50%; }
  .author { font-weight:600; color:#fff; }
  .head.bot .author { color:#5865F2; }
  .time { color:#80848e; font-size:12px; }
  .body { white-space:pre-wrap; word-break:break-word; font-size:14px; line-height:1.45; }
  a { color:#00a8fc; }
  .empty { color:#80848e; font-style:italic; }
</style>
</head>
<body>
    <div class="wrap">
        <header>
            <h1>Ticket #${esc(ticketNumber)} — ${esc(reason || 'no reason given')}</h1>
            <div class="meta">
                <b>${esc(guild)}</b> · channel ${esc(channel)} · opened ${date} by <b>${esc(openedBy)}</b> ·
                closed by <b>${esc(closedBy)}</b>${closeReason ? ` — reason: <b>${esc(closeReason)}</b>` : ''}
            </div>
        </header>
        <main>
${(messages || []).map(renderMessage).join('\n')}
        </main>
    </div>
</body>
</html>`;
}

/**
 * The same transcript as plain readable lines, for the "View transcript"
 * button. Deliberately NOT code-formatted: this is read in a Discord reply,
 * where a wall of markup helps nobody.
 */
function buildTranscriptText({ guild, ticketNumber, reason, openedBy, closedBy, closeReason, messages }) {
  const head = [
    `Ticket #${ticketNumber}${reason ? ` — ${reason}` : ''}${guild ? ` · ${guild}` : ''}`,
    `Opened by ${openedBy || 'unknown'} · closed by ${closedBy || 'system'}`,
    `Close reason: ${closeReason || 'No reason specified'}`,
    '',
  ];
  const body = (messages || []).map((m) => {
    const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 16);
    const who = `${m.author ? m.author.username : 'unknown'}${m.author && m.author.bot ? ' (bot)' : ''}`;
    const files = m.attachments && m.attachments.size
      ? ` [${[...m.attachments.values()].map((a) => a.name).join(', ')}]`
      : '';
    const text = (m.content || '').trim();
    return `[${when}] ${who}: ${text || '(no text)'}${files}`;
  });
  return head.concat(body).join('\n');
}

module.exports = { buildTranscriptHtml, buildTranscriptText, esc };