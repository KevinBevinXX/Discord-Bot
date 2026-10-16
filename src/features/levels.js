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
const { EmbedBuilder } = require('discord.js');
const Schema = require('../schema');
const db = require('../db');
const context = require('../context');
const { fill, bar, fmtNum, log, err, hasAnyRole, isAdmin } = require('../util');

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
  const gained = min === max ? max : min + Math.floor(Math.random() * (max - min + 1));
  if (gained <= 0) return false;

  const row = db.getXp(message.guildId, message.author.id);
  const alreadyMax = row.level >= L.maxLevel;
  let level = row.level;
  let xpInto = row.xp + gained;
  const base = L.xpBase, growth = L.xpGrowth;
  if (!alreadyMax) {
    while (level < L.maxLevel) {
      const cost = Schema.costToNext(level, base, growth);
      if (xpInto < cost) break;
      xpInto -= cost;
      level++;
    }
  }
  db.applyXpGain(message.guildId, message.author.id, gained, level, Math.floor(Date.now() / 1000));
  if (level !== row.level) await celebrate(message, level, L, cfg);
  return true;
}

async function celebrate(message, newLevel, L, cfg) {
  const where = L.announceChannelId
    ? message.guild.channels.cache.get(L.announceChannelId) || message.channel
    : message.channel;
  const text = fill(L.announceMessage || '{user} just hit **level {level}**! 🎉', {
    user: `<@${message.author.id}>`,
    username: message.author.username,
    level: newLevel,
    server: message.guild.name,
  });
  await where.send({ content: text.slice(0, 1900), allowedMentions: { users: [message.author.id] } }).catch((e) => err(TAG, `announce: ${e.message}`));
  if (L.dmLevelUp) message.author.send(text.slice(0, 1900)).catch(() => {});
  log(TAG, `${message.author.username} reached level ${newLevel}`);

  if ((L.roleRewards || []).length) {
    const earned = L.roleRewards.filter((r) => r.level <= newLevel).sort((a, b) => b.level - a.level);
    if (earned.length) {
      const grant = L.rewardMode === 'replace' ? [earned[0]] : earned;
      try {
        const me = message.guild.members.me;
        for (const reward of grant) {
          const role = message.guild.roles.cache.get(reward.roleId);
          if (role && role.position < me.roles.highest.position) {
            await message.member.roles.add(reward.roleId, `level ${newLevel} reward`);
          }
        }
        if (L.rewardMode === 'replace' && earned.length > 1) {
          for (const lower of earned.slice(1)) {
            if (message.member.roles.cache.has(lower.roleId)) {
              await message.member.roles.remove(lower.roleId, 'level reward (replace mode)').catch(() => {});
            }
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

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${member ? member.displayName : targetUser.username}'s level card`)
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
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🏆 Leaderboard — page ${page}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${fmtNum(db.totalTracked(interaction.guildId))} members tracked · /leaderboard <page>` });
  await interaction.reply({ embeds: [embed] }).catch(() => {});
}

module.exports = { handleMessage, rankCard, leaderboard, careerXp };