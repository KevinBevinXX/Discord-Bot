/**
 * Levels (Arcane-style).
 *
 * - Messages grant a random amount of XP between xpMin/xpMax, one drop per
 *   user per cooldownSeconds (spam doesn't farm XP).
 * - Level curve: cost from level L to L+1 is round(xpBase * xpGrowth^L);
 *   xpBase/xpGrowth/maxLevel are dashboard-configurable.
 * - Level-ups announce in the configured channel (or the one the message was
 *   in) with a template message; roleRewards grant (stack or single) roles.
 * - Commands: /rank /leaderboard /givexp /resetxp live in src/commands.js
 *   and call into this module.
 */
const Schema = require('../schema');
const db = require('../db');
const context = require('../context');
const { fill, bar, fmtNum, log, err, hasAnyRole, isAdmin } = require('../util');
const theme = require('../theme');

const TAG = 'levels';
const cooldowns = new Map(); // `${guildId}:${userId}` -> last xp ms

/** Pure-ish entry from messageCreate. */
async function handleMessage(message) {
  const cfg = context.currentConfig();
  const L = cfg.levels || {};
  if (!L.enabled) return false;
  if (message.guildId !== cfg.general.guildId) return false;
  if (message.author.bot || !message.member) return false;
  if ((L.noXpChannelIds || []).includes(message.channelId)) return false;
  if ((L.noXpRoleIds || []).length && hasAnyRole(message.member, L.noXpRoleIds)) return false;

  if (L.cooldownSeconds > 0) {
    const key = `${message.guildId}:${message.author.id}`;
    const last = cooldowns.get(key) || 0;
    if (Date.now() - last < L.cooldownSeconds * 1000) return false;
    cooldowns.set(key, Date.now());
  }

  const min = Math.min(L.xpMin ?? 5, L.xpMax ?? 15);
  const max = Math.max(L.xpMin ?? 5, L.xpMax ?? 15);
  const raw = min === max ? max : min + Math.floor(Math.random() * (max - min + 1));
  const mult = multiplierOf(message.member, L);
  const gained = Math.round(raw * mult);
  if (gained <= 0) return false;

  await grantXp(message.guild, message.member, gained, L, cfg);
  return true;
}


/** Sum of every matching role multiplier (percent → fraction). Pure. */
function multiplierOf(member, L) {
  const list = (L && L.xpMultipliers) || [];
  let total = list.length ? 100 : 100; // no list = normal rate; list present = base 100 still applies
  let matched = false;
  for (const m of list) {
    if (m && m.roleId && member && member.roles.cache.has(m.roleId)) {
      total += (m.percent ?? 100) - 100;
      matched = true;
    }
  }
  return total <= 0 ? 0 : total / 100;
}

/** Shared grant path for message XP and voice XP. */
async function grantXp(guild, member, amount, L, cfg) {
  if (!amount || amount <= 0) return;
  const row = db.getXp(guild.id, member.id);
  const alreadyMax = row.level >= L.maxLevel;
  let level = row.level;
  let xpInto = row.xp + amount;
  if (!alreadyMax) {
    while (level < L.maxLevel) {
      const cost = Schema.costToNext(level, L.xpBase, L.xpGrowth);
      if (xpInto < cost) break;
      xpInto -= cost;
      level++;
    }
  }
  db.applyXpGain(guild.id, member.id, amount, level, Math.floor(Date.now() / 1000));
  if (level !== row.level) await celebrateMember(guild, member, level, L, cfg);
}

async function celebrateMember(guild, member, newLevel, L, cfg) {
  const where = L.announceChannelId
    ? guild.channels.cache.get(L.announceChannelId)
    : null;
  const text = fill(L.announceMessage || '{user} just hit **level {level}**! 🎉', {
    user: `<@${member.id}>`,
    username: member.user.username,
    level: newLevel,
    server: guild.name,
  });
  const ann = theme.embed(member.client, {
    color: theme.COLORS.success,
    title: '🎉 Level up!',
    description: text,
    footer: `Levels · ${guild.name}`,
  });
  if (where && where.isTextBased()) await where.send({ embeds: [ann], allowedMentions: { users: [member.id] } }).catch((e) => err(TAG, `announce: ${e.message}`));
  if (L.dmLevelUp) member.send({ embeds: [ann] }).catch(() => {});
  log(TAG, `${member.user.username} reached level ${newLevel}`);

  if ((L.roleRewards || []).length) {
    const earned = L.roleRewards.filter((r) => r.level <= newLevel).sort((a, b) => b.level - a.level);
    if (earned.length) {
      const grant = L.rewardMode === 'replace' ? [earned[0]] : earned;
      try {
        const me = guild.members.me;
        for (const reward of grant) {
          const role = guild.roles.cache.get(reward.roleId);
          if (role && role.position < me.roles.highest.position) await member.roles.add(reward.roleId, `level ${newLevel} reward`);
        }
        if (L.rewardMode === 'replace' && earned.length > 1) {
          for (const lower of earned.slice(1)) {
            if (member.roles.cache.has(lower.roleId)) await member.roles.remove(lower.roleId, 'level reward (replace mode)').catch(() => {});
          }
        }
      } catch (e) {
        err(TAG, `reward roles: ${e.message} — is my role above the reward roles?`);
      }
    }
  }
}

/* ------------------------------- data helpers ------------------------------ */

/** xp accumulated over the whole career = Σ costs up to level + xp-into-current */
function careerXp(row, base, growth) {
  let sum = 0;
  for (let i = 0; i < row.level; i++) sum += Schema.costToNext(i, base, growth);
  return sum + row.xp;
}

async function rankCard(interaction, targetUser) {
  const cfg = context.currentConfig();
  const L = cfg.levels || {};
  const row = db.getXp(interaction.guildId, targetUser.id);
  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  const cost = Schema.costToNext(row.level, L.xpBase, L.xpGrowth);
  const rank = db.leaderboardRank(interaction.guildId, targetUser.id);
  const nextAt = row.level >= L.maxLevel ? null : Schema.totalXpForLevel(row.level, L.xpBase, L.xpGrowth) + cost;

  const embed = theme.embed(interaction.client, {
    title: `${member ? member.displayName : targetUser.username}'s level card`,
    footer: `Levels · rank command`,
  })
    .setThumbnail(member ? member.displayAvatarURL({ size: 128 }) : targetUser.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: 'Level', value: `**${row.level}**${row.level >= L.maxLevel ? ' (max)' : ''}`, inline: true },
      { name: 'Rank', value: rank ? `#${rank} of ${fmtNum(db.totalTracked(interaction.guildId))}` : 'unranked', inline: true },
      { name: 'Messages', value: fmtNum(row.messages), inline: true },
      { name: 'Progress to next level', value: row.level >= L.maxLevel ? 'Maxed out 🏆' : `${bar(row.xp, cost)} ${fmtNum(row.xp)} / ${fmtNum(cost)}` },
      { name: 'Total XP earned', value: fmtNum(careerXp(row, L.xpBase, L.xpGrowth)) + (nextAt !== null ? ` · next level at ${fmtNum(nextAt)}` : ''), inline: false },
    );
  await interaction.reply({ embeds: [embed], ephemeral: false }).catch(() => {});
}

async function leaderboard(interaction, page) {
  const cfg = context.currentConfig();
  const L = cfg.levels || {};
  const per = 10;
  const atLeast = (page - 1) * per;
  const rows = db.leaderboard(interaction.guildId, per, atLeast);
  if (!rows.length) {
    await interaction.reply({ content: 'Nobody has earned XP yet. Chat and find out!', ephemeral: true }).catch(() => {});
    return;
  }
  const lines = rows.map((r, i) => {
    const medal = atLeast + i === 0 ? '🥇' : atLeast + i === 1 ? '🥈' : atLeast + i === 2 ? '🥉' : `**${atLeast + i + 1}.**`;
    return `${medal} <@${r.userId}> — level **${r.level}** · ${fmtNum(r.xp)} xp into level · ${fmtNum(r.messages)} msgs`;
  });
  const embed = theme.embed(interaction.client, {
    title: `🏆 Leaderboard — page ${page}`,
    description: lines.join('\n'),
    footer: `${fmtNum(db.totalTracked(interaction.guildId))} members tracked · /leaderboard <page>`,
  });
  await interaction.reply({ embeds: [embed] }).catch(() => {});
}

/* voice XP — Arcane style: flat XP per minute in a voice channel */
const VOICE_TICK_MS = 60 * 1000;
function startVoiceTicker(client) {
  return setInterval(() => {
    try {
      const cfg = context.currentConfig();
      const L = cfg.levels || {};
      if (!L.enabled || !L.voiceXpPerMinute || !cfg.general.guildId) return;
      const guild = client.guilds.cache.get(cfg.general.guildId);
      if (!guild) return;
      const nowSec = Math.floor(Date.now() / 1000);
      for (const [_, state] of guild.voiceStates.cache) {
        if (state.member && !state.member.user.bot && state.channelId && state.channelId !== guild.afkChannelId) {
          if ((L.noXpRoleIds || []).length && hasAnyRole(state.member, L.noXpRoleIds)) continue;
          void grantXp(guild, state.member, L.voiceXpPerMinute, L, cfg);
        }
      }
    } catch (e) {
      err(TAG, `voice tick: ${e.message}`);
    }
  }, VOICE_TICK_MS).unref();
}

module.exports = { handleMessage, rankCard, leaderboard, careerXp, multiplierOf, startVoiceTicker };