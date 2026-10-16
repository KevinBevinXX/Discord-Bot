/**
 * Auto-moderation.
 *
 * Filters (dashboard-configurable): banned words (with 1337-speak normalising),
 * Discord invites (with allowlist), any links (domain allowlist), excessive
 * caps, emoji spam, mention spam, and fast-message spam. Each hit takes the
 * rule's action (none / delete / delete+warn / delete+timeout), logs to the
 * log channel, and adds ONE strike. The strike ladder then escalates:
 * timeout at N, kick at M, ban at B (per dashboard config).
 *
 * The text checks below are pure functions so the test suite can exercise
 * them without a Discord connection.
 */

// ---------------------------------------------------------------- pure checks

const LEET = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '€': 'e',
};

function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')                 // é -> e + combining mark
    .replace(/[\u0300-\u036f]/g, '')  // drop the combining marks
    .split('')
    .map((ch) => LEET[ch] || ch)
    .join('')
    .replace(/[^a-z0-9\s]/g, ' ')     // punctuation to spaces (c.o.c -> c o c)
    .replace(/\s+/g, ' ')
    .trim();
}

const IGNORED_COMMONS = new Set(['and', 'or', 'the', 'a', 'of', 'to', 'is', 'it', 'at', 'on']); // unused

/** Returns the banned entry that matched, or null. */
function checkBannedWords(content, words) {
  if (!Array.isArray(words) || !words.length) return null;
  const norm = normalizeText(content);
  const tokens = norm.split(' ');
  for (const rawWord of words) {
    const w = normalizeText(rawWord);
    if (!w) continue;
    if (w.includes(' ') || /[^a-z0-9]/.test(w)) {
      // multi-word phrase or digits/punct mixed: substring match is the only fair check
      if (norm.includes(w)) return rawWord;
    } else {
      if (tokens.includes(w)) return rawWord; // exact token ("grape")
      // anti-evasion: "g r a p e" compacts to 'grape' — boundary-guarded so
      // 'grapes' still does not count as 'grape'
      const compacted = norm.replace(/ /g, '');
      if (compacted.includes(w) && new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(compacted)) {
        return rawWord;
      }
    }
  }
  return null;
}

function checkInvites(content, allowlist) {
  const found = String(content).match(/(?:discord\.gg|discord(app)?\.com\/invite)\/([A-Za-z0-9_-]+)/g);
  if (!found || !found.length) return null;
  const allowed = (allowlist || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  for (const raw of found) {
    const code = raw.split('/').pop().toLowerCase();
    if (!allowed.length) return raw;
    if (!allowed.some((a) => code === a || code.startsWith(a))) return raw;
  }
  return null;
}

function checkLinks(content, allowlistDomains) {
  const found = String(content).match(/(?:https?:\/\/|www\.)[^\s<]+/gi) || [];
  const bare = String(content).match(/\b[a-z0-9-]+\.(com|net|org|io|gg|me|co|xyz|dev|org\.uk)\b/gi) || [];
  const urls = [...found, ...bare.map((b) => b)];
  if (!urls.length) return null;
  const allowed = (allowlistDomains || []).map((s) => String(s).trim().toLowerCase().replace(/^https?:\/\//, '')).filter(Boolean);
  const hostOf = (u) => {
    try {
      const withProto = /^https?:\/\//i.test(u) ? u : `http://${u}`;
      return new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return u.toLowerCase();
    }
  };
  for (const u of urls) {
    const host = hostOf(u);
    if (!allowed.length) return u.slice(0, 80);
    if (!allowed.some((a) => host === a || host.endsWith(`.${a.replace(/^www\./, '')}`))) return u.slice(0, 80);
  }
  return null;
}

function checkCaps(content, minLength, percent) {
  const letters = String(content).replace(/[^A-Za-z]/g, '');
  if (letters.length < minLength) return null;
  const caps = letters.replace(/[^A-Z]/g, '').length;
  const ratio = Math.round((caps / letters.length) * 100);
  return ratio >= percent ? { ratio } : null;
}

const EMOJI_RE = /(\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*)|<[a]?:[a-zA-Z0-9_~]+:[0-9]{15,21}>/gu;

function checkEmojis(content, max) {
  const count = (String(content).match(EMOJI_RE) || []).length;
  return count > max ? { count } : null;
}

function checkMentions(message, max) {
  const count = message.mentions ? message.mentions.users.filter((u) => u.id !== message.author.id).length : 0;
  return count > max ? { count } : null;
}

/** Sliding-window spam tracker (stateful, but unit-testable). */
class SpamTracker {
  constructor() {
    this.hits = new Map();
  }

  isSpam(userId, now, withinSeconds, count) {
    const arr = (this.hits.get(userId) || []).filter((t) => now - t <= withinSeconds * 1000);
    arr.push(now);
    this.hits.set(userId, arr);
    return arr.length >= count;
  }
}

// exports are set at the bottom (pure functions above are used by the tests)

// ---------------------------------------------------------------- gateway side

const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const context = require('../context');
const { err, isAdmin, hasAnyRole } = require('../util');

const TAG = 'automod';
const spam = new SpamTracker();
const lastEscalation = new Map(); // `${guildId}:${userId}` -> tier tier last fired

const RULE_ORDER = ['bannedWords', 'inviteLinks', 'externalLinks', 'excessiveCaps', 'excessiveEmojis', 'massMentions'];

function evaluate(message, cfg) {
  const a = cfg.automod || {};
  for (const ruleKey of RULE_ORDER) {
    const rule = a[ruleKey];
    if (!rule || !rule.enabled) continue;
    let hit = null;
    switch (ruleKey) {
      case 'bannedWords': hit = checkBannedWords(message.content, rule.words); break;
      case 'inviteLinks': hit = checkInvites(message.content, rule.allowlist); break;
      case 'externalLinks': hit = checkLinks(message.content, rule.allowlist); break;
      case 'excessiveCaps': hit = checkCaps(message.content, rule.minLength, rule.percent); break;
      case 'excessiveEmojis': hit = checkEmojis(message.content, rule.max); break;
      case 'massMentions': hit = checkMentions(message, rule.max); break;
    }
    if (hit) return { rule: ruleKey, ruleCfg: rule, hit };
  }
  const ms = a.messageSpam;
  if (ms && ms.enabled && spam.isSpam(message.author.id, Date.now(), ms.withinSeconds, ms.messages)) {
    return { rule: 'messageSpam', ruleCfg: ms, hit: true };
  }
  return null;
}

async function handleMessage(message) {
  const cfg = context.currentConfig();
  const a = cfg.automod || {};
  if (!a.enabled) return false;
  if (message.guildId !== cfg.general.guildId) return false;
  if (message.author.bot || message.webhookId) return false;
  if ((a.exemptChannelIds || []).includes(message.channelId)) return false;
  if (message.member && (isAdmin(message.member, cfg.general.adminRoleIds) || message.member.permissions.has('ManageMessages'))) return false;
  if (message.member && hasAnyRole(message.member, a.exemptRoleIds)) return false;

  const violation = evaluate(message, cfg);
  if (!violation) return false;

  const { rule, ruleCfg } = violation;
  const action = ruleCfg.action || 'delete';
  const excerpt = (message.content || '').slice(0, 100);

  if (action !== 'none') {
    await message.delete(`automod: ${rule}`).catch((e) => err(TAG, `delete failed: ${e.message}`));
  }

  if (a.notifyUser && action !== 'none') {
    const why = HUMAN[rule] || 'Your message broke the rules.';
    const notice = await message.channel.send(`${message.author}, ${why} (removed by auto-mod)`).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000);
  }

  if (action.includes('timeout')) {
    const minutes = ruleCfg.timeoutMinutes || a.timeoutMinutes || 10;
    await message.member.timeout(minutes * 60 * 1000, `automod: ${rule}`).catch((e) => err(TAG, `timeout failed: ${e.message}`));
  }

  const before = lastEscalation.get(`${message.guildId}:${message.author.id}`) || 0;
  db.addStrike(message.guildId, message.author.id, `automod:${rule}`, excerpt, '', Math.floor(Date.now() / 1000));
  await runLadder(message, cfg, before);
  logEmbed(message, cfg, rule, excerpt, action);
  return true;
}

const HUMAN = {
  bannedWords: 'that word is not allowed here.',
  inviteLinks: 'advertising other servers is not allowed.',
  externalLinks: 'links are not allowed here.',
  excessiveCaps: 'ease up on the CAPS.',
  excessiveEmojis: 'that is too many emojis.',
  massMentions: 'stop mass-mentioning people.',
  messageSpam: 'you are sending messages too fast.',
};

async function runLadder(message, cfg, previousCount) {
  const ladder = cfg.automod.strikes || {};
  const now = db.strikeCount(message.guildId, message.author.id);
  const key = `${message.guildId}:${message.author.id}`;
  let fired = previousCount;
  const tiers = [
    { at: ladder.banAt, fn: () => message.member.ban({ reason: `auto-mod strike ladder (${now} strikes)` }), name: 'ban' },
    { at: ladder.kickAt, fn: () => message.member.kick(`auto-mod strike ladder (${now} strikes)`), name: 'kick' },
    { at: ladder.timeoutAt, fn: () => message.member.timeout((ladder.timeoutMinutes || 60) * 60 * 1000, `auto-mod strike ladder (${now} strikes)`), name: 'timeout' },
  ];
  // highest tier first
  for (const tier of tiers) {
    if (tier.at > 0 && now >= tier.at && fired < tier.at) {
      fired = tier.at;
      await tier.fn().then(async () => {
        const did = tier.name === 'ban' ? 'banned' : tier.name === 'kick' ? 'kicked' : 'timed out';
        await message.channel.send(`⚖️ <@${message.author.id}> reached ${now} strikes — they have been ${did}.`).catch(() => {});
      }).catch((e) => err(TAG, `${tier.name} failed (permissions?): ${e.message}`));
      lastEscalation.set(key, fired);
      logToChannel(cfg, `⚖️ ${message.author.tag} hit the strike ladder at ${now} strikes → ${tier.name}.`);
      break; // only escalate to the single highest new tier
    }
  }
}

function logEmbed(message, cfg, rule, excerpt, action) {
  const logId = cfg.automod.logChannelId || cfg.general.logChannelId;
  if (!logId) return;
  const ch = message.guild.channels.cache.get(logId);
  if (!ch || !ch.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`Auto-mod: ${rule}`)
    .addFields(
      { name: 'User', value: `<@${message.author.id}> (\`${message.author.username}\`)`, inline: true },
      { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
      { name: 'Action', value: action, inline: true },
      { name: 'Message', value: (`${excerpt || '(no text)'}`).slice(0, 1000) },
    )
    .setTimestamp();
  ch.send({ embeds: [embed] }).catch(() => {});
}

function logToChannel(cfg, content) {
  const logId = cfg.automod.logChannelId || cfg.general.logChannelId;
  if (!logId || !context.getClient()) return;
  const guild = context.getClient().guilds.cache.get(cfg.general.guildId);
  const ch = guild && guild.channels.cache.get(logId);
  if (ch && ch.isTextBased()) ch.send({ content: content.slice(0, 1900) }).catch(() => {});
}

module.exports.handleMessage = handleMessage;
module.exports.resetEscalation = (guildId, userId) => lastEscalation.delete(`${guildId}:${userId}`);
module.exports.spam = spam;
Object.assign(module.exports, { normalizeText, checkBannedWords, checkInvites, checkLinks, checkCaps, checkEmojis, checkMentions, SpamTracker });