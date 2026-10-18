/**
 * Welcome & goodbye: greeting message in a channel and/or DM on join, an auto
 * role, and a farewell on leave. Placeholders: {user} {username} {server}
 * {memberCount}.
 */
const context = require('../context');
const { fill, log, err } = require('../util');
const theme = require('../theme');

const TAG = 'welcome';

async function onJoin(member) {
  const cfg = context.currentConfig();
  const w = cfg.welcome || {};
  if (!w.enabled || member.guild.id !== cfg.general.guildId) return;

  for (const roleId of w.autoroleIds || []) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role) {
      err(TAG, `auto role ${roleId} no longer exists`);
      continue;
    }
    if (role.position < member.guild.members.me.roles.highest.position) {
      await member.roles.add(role, 'auto role on join').catch((e) => err(TAG, `auto role failed: ${e.message}`));
    } else {
      err(TAG, `my role is below ${role.name} — move it higher to grant it`);
    }
  }

  const vars = {
    user: `<@${member.id}>`,
    username: member.user.username,
    server: member.guild.name,
    memberCount: member.guild.memberCount,
  };
  if (w.welcomeChannelId && w.welcomeMessage) {
    const ch = member.guild.channels.cache.get(w.welcomeChannelId);
    const greet = theme.embed(member.client, {
      color: theme.COLORS.success,
      title: `👋 Welcome to ${member.guild.name}!`,
      description: fill(w.welcomeMessage, vars),
      footer: false, // no "KBX Community Bot · member #N · <time>" line
    });
    if (ch && ch.isTextBased()) await ch.send({ embeds: [greet], allowedMentions: { users: [member.id] } }).catch((e) => err(TAG, `welcome send: ${e.message}`));
    else err(TAG, `welcome channel ${w.welcomeChannelId} not found or not text`);
  }
  if (w.dmWelcome) {
    await member.send(fill(w.dmWelcome, vars).slice(0, 1900)).catch(() => { /* DMs closed — fine */ });
  }
  log(TAG, `${member.user.username} joined (member #${member.guild.memberCount})`);
}

async function onLeave(member) {
  const cfg = context.currentConfig();
  const w = cfg.welcome || {};
  if (!w.enabled || !w.leaveChannelId || !w.leaveMessage || member.guild.id !== cfg.general.guildId) return;
  const ch = member.guild.channels.cache.get(w.leaveChannelId);
  if (!ch) return err(TAG, `goodbye channel ${w.leaveChannelId} not found`);
  const bye = theme.embed(member.client, {
    color: theme.COLORS.neutral,
    title: '🚪 Goodbye',
    description: fill(w.leaveMessage, {
      user: `<@${member.id}>`,
      username: member.user.username,
      server: member.guild.name,
      memberCount: member.guild.memberCount,
    }),
    footer: 'Welcome & goodbye',
  });
  await ch.send({ embeds: [bye] }).catch((e) => err(TAG, `leave send: ${e.message}`));
}

module.exports = { onJoin, onLeave };