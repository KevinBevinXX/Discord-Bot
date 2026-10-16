/**
 * Manual moderation: /warn, /warnings, /clearwarnings — the same strike pool
 * the auto-mod escalates from, so a warned member climbs the same ladder.
 */
const db = require('../db');
const context = require('../context');
const { isAdmin, hasAnyRole, log } = require('../util');

const TAG = 'moderation';

function isModerator(member, cfg) {
  if (!member) return false;
  if (member.permissions && member.permissions.has('KickMembers')) return true;
  return isAdmin(member, cfg.general.adminRoleIds);
}

async function warn(interaction) {
  const cfg = context.currentConfig();
  if (!isModerator(interaction.member, cfg)) {
    return void interaction.reply({ content: 'You are not allowed to warn people.', ephemeral: true }).catch(() => {});
  }
  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || '';
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (member && (member.user.bot || isModerator(member, cfg))) {
    return void interaction.reply({ content: 'You cannot warn another moderator.', ephemeral: true }).catch(() => {});
  }

  db.addStrike(interaction.guildId, target.id, 'command', reason, interaction.user.id, Math.floor(Date.now() / 1000));
  await target.send(`⚠️ You were warned in **${interaction.guild.name}**${reason ? `: ${reason}` : '.'}`).catch(() => {});

  const count = db.strikeCount(interaction.guildId, target.id);
  const ladder = cfg.automod && cfg.automod.strikes ? cfg.automod.strikes : {};
  const next = [];
  if (ladder.timeoutAt > count) next.push(`timeout at ${ladder.timeoutAt}`);
  if (ladder.kickAt > count) next.push(`kick at ${ladder.kickAt}`);
  if (ladder.banAt > count) next.push(`ban at ${ladder.banAt}`);
  await interaction.reply({
    content: `⚠️ Warned <@${target.id}> (${count} strike${count === 1 ? '' : 's'})${reason ? ` — *${reason}*` : ''}.${next.length ? ` Ladder: ${next.join(', ')}.` : ''}`,
    allowedMentions: { users: [] },
  }).catch(() => {});

  const logId = cfg.general.logChannelId;
  if (logId) interaction.guild.channels.cache.get(logId)?.send(`⚠️ ${interaction.user.tag} warned ${target.tag} (${count} strikes)${reason ? ` — ${reason}` : ''}`).catch(() => {});
  log(TAG, `${interaction.user.username} warned ${target.username}: ${reason}`);
}

async function warnings(interaction) {
  const cfg = context.currentConfig();
  if (!isModerator(interaction.member, cfg)) {
    return void interaction.reply({ content: 'You are not allowed to view warnings.', ephemeral: true }).catch(() => {});
  }
  const target = interaction.options.getUser('user', true);
  const rows = db.strikesFor(interaction.guildId, target.id, 15);
  const count = db.strikeCount(interaction.guildId, target.id);
  if (!rows.length) {
    return void interaction.reply({ content: `**${target.username}** has a clean record. 🕊️`, ephemeral: true }).catch(() => {});
  }
  const lines = rows.map((r) => `• \`#${r.id}\` <t:${r.createdAt}:R> — **${r.source.startsWith('automod:') ? r.source.slice(8) : 'manual'}**${r.reason ? ` — ${r.reason.slice(0, 80)}` : ''}`);
  await interaction.reply({
    content: `🧾 **${target.username}** — ${count} strike${count === 1 ? '' : 's'} (showing latest ${rows.length}):\n${lines.join('\n')}`.slice(0, 1900),
    ephemeral: true,
  }).catch(() => {});
}

async function clear(interaction) {
  const cfg = context.currentConfig();
  if (!isAdmin(interaction.member, cfg.general.adminRoleIds)) {
    return void interaction.reply({ content: 'Only admins can clear warnings.', ephemeral: true }).catch(() => {});
  }
  const target = interaction.options.getUser('user', true);
  const removed = db.clearStrikes(interaction.guildId, target.id);
  require('./automod').resetEscalation(interaction.guildId, target.id);
  await interaction.reply({ content: `🧽 Cleared ${removed} strike${removed === 1 ? '' : 's'} from <@${target.id}>.`, allowedMentions: { users: [] }, ephemeral: true }).catch(() => {});
}

module.exports = { warn, warnings, clear, isModerator };