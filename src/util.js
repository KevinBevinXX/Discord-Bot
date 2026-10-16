/** Small shared helpers: logging, placeholders, emoji handling, guards. */
const MAX_LOG_LEN = 300;

function log(tag, message) {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}`;
  console.log(line);
}

function err(tag, messageOrError) {
  const e = messageOrError instanceof Error ? `${messageOrError.message}` : String(messageOrError);
  const m = e.length > MAX_LOG_LEN ? `${e.slice(0, MAX_LOG_LEN)}…` : e;
  log(tag, `⚠ ${m}`);
}

const SNOWFLAKE = /^[0-9]{15,21}$/;

function isSnowflake(v) {
  return typeof v === 'string' && SNOWFLAKE.test(v);
}

/**
 * Emoji handling.	Config stores whatever the dashboard sent; coming back from
 * Discord, reactions give { name, id } (custom) or { name: '🎮' } (unicode).
 * We normalise both sides to one key so matches are stable.
 */
function emojiKey(emoji) {
  if (!emoji) return '';
  if (typeof emoji === 'string') emoji = parseEmoji(emoji);
  if (!emoji) return '';
  const name = String(emoji.name || '').replace(/[\uFE0F\u200D]/g, '');
  if (emoji.id) return `c:${name}:${emoji.id}`;
  return `u:${name}`;
}

/** Accepts '🎮', '<:blobreach:123…>', '<a:x:123…>', ':name:id', 'name:id', '<a:name:id>'. */
function parseEmoji(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  let m = s.match(/^<a?:([a-zA-Z0-9_~]{2,32}):([0-9]{15,21})>$/);
  if (m) return { name: m[1], id: m[2], animated: s.startsWith('<a') };
  m = s.match(/^:?([a-zA-Z0-9_~]{2,32}):([0-9]{15,21}):?$/);
  if (m) return { name: m[1], id: m[2], animated: false };
  if (/\p{Extended_Pictographic}|[\u2600-\u27BF]|^\p{So}+$/u.test(s)) {
    return { name: s, id: undefined, animated: false }; // unicode (kept verbatim for display)
  }
  return { name: s, id: undefined, animated: false }; // best effort: a guild emoji's bare name
}

/** String used to actually react (unicode stays, custom goes name:id). */
function toReact(emojiLike) {
  const parsed = typeof emojiLike === 'object' && emojiLike !== null ? emojiLike : parseEmoji(emojiLike);
  if (!parsed || !parsed.name) return null;
  return parsed.id ? (parsed.animated ? `a:${parsed.name}:${parsed.id}` : `${parsed.name}:${parsed.id}`) : parsed.name;
}

function displayEmoji(emojiLike) {
  const parsed = typeof emojiLike === 'object' && emojiLike !== null ? emojiLike : parseEmoji(emojiLike);
  if (!parsed) return '';
  return parsed.id ? `<${parsed.animated ? 'a' : ''}:${parsed.name}:${parsed.id}>` : parsed.name;
}

/** Message placeholders: {user} {username} {server} {level} {memberCount} {reason} … */
function fill(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : m);
}

/** Deep-ish flat diff summary for logs: which top-level sections changed. */
function changedSections(before, after) {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (JSON.stringify(before ? before[k] : null) !== JSON.stringify(after ? after[k] : null)) out.push(k);
  }
  return out;
}

async function safeSend(channel, payload, tag) {
  if (!channel) return null;
  try {
    return await channel.send(payload);
  } catch (e) {
    err(tag || 'send', `could not send into ${channel.id}: ${e.message}`);
    return null;
  }
}

/** Is this member covered by one of the role IDs / guild admin? */
function hasAnyRole(member, roleIds) {
  if (!member) return false;
  if (roleIds === undefined || roleIds === null) return false;
  for (const id of roleIds) if (member.roles.cache.has(id)) return true;
  return false;
}

function isAdmin(member, adminRoleIds) {
  if (!member) return false;
  if (member.permissions && member.permissions.has('ManageGuild')) return true;
  return hasAnyRole(member, adminRoleIds);
}

function bar(current, max, size = 10) {
  if (max <= 0) return '█'.repeat(size);
  const filled = Math.min(size, Math.round((current / max) * size));
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

module.exports = { log, err, isSnowflake, emojiKey, parseEmoji, toReact, displayEmoji, fill, changedSections, safeSend, hasAnyRole, isAdmin, bar, fmtNum };