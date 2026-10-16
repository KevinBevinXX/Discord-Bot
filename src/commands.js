/**
 * All slash commands in one registry: { data, handle } entries.
 * index.js registers + routes them.
 */
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const configModule = require('./config');
const db = require('./db');
const Schema = require('./schema');
const levels = require('./features/levels');
const moderation = require('./features/moderation');
const { isAdmin, fmtNum, log } = require('./util');

const TAG = 'commands';

const COMMANDS = [
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Latency check'),
    handle: async (interaction) => {
      const sent = await interaction.reply({ content: 'Pinging…', fetchReply: true });
      await interaction.editReply(`🏓 Pong! Round-trip ${sent.createdTimestamp - interaction.createdTimestamp}ms · websocket ${Math.round(interaction.client.ws.ping)}ms`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('help').setDescription('What this bot does and how to configure it'),
    handle: async (interaction) => {
      const cfg = context.currentConfig();
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("KevinBevinX's Community Bot")
        .setDescription(' Tickets 🎫 · Reaction roles 🔁 · Levels 📶 · Auto-mod 🛡️ · Welcome 👋 · Warnings ⚠️')
        .addFields(
          { name: 'Ticket system', value: 'Use the panel button, pick a reason, staff claim & close with a reason. Transcripts land in the log channel.' },
          { name: 'Levels', value: 'Chat to earn XP (`/rank`, `/leaderboard`). Level-up messages and role rewards are configured on the dashboard.' },
          { name: 'Auto-mod', value: `Filters + a strike ladder${cfg.automod && cfg.automod.enabled ? ' — **on**' : ' — currently off'}.` },
          { name: 'Configure everything', value: 'The GitHub Pages dashboard (see README) — changes apply here automatically.', inline: false },
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName('botinfo').setDescription('Uptime, config source, feature status'),
    handle: async (interaction) => {
      const cfg = context.currentConfig();
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Bot status')
        .addFields(
          { name: 'Config source', value: process.env.GITHUB_REPO ? `github.com/${process.env.GITHUB_REPO} (${process.env.GITHUB_BRANCH || 'main'})` : 'default (no repo configured)', inline: true },
          { name: 'Feature state', value: [
            `Tickets: ${cfg.tickets.enabled ? 'on' : 'off'}`,
            `Reaction roles: ${cfg.reactionRoles.enabled ? 'on' : 'off'}`,
            `Levels: ${cfg.levels.enabled ? 'on' : 'off'}`,
            `Auto-mod: ${cfg.automod.enabled ? 'on' : 'off'}`,
            `Welcome: ${cfg.welcome.enabled ? 'on' : 'off'}`,
          ].join('\n'), inline: false },
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName('configreload').setDescription('Admin: refetch the dashboard config now'),
    handle: async (interaction) => {
      const cfg = context.currentConfig();
      if (!isAdmin(interaction.member, cfg.general.adminRoleIds)) {
        return void interaction.reply({ content: 'Admins only.', ephemeral: true }).catch(() => {});
      }
      await interaction.deferReply({ ephemeral: true });
      await configModule.reload();
      await interaction.editReply('🔄 Config refetched from GitHub (if it was changed, features updated just now).').catch(() => {});
    },
  },

  // levels ------------------------------------------------------------------
  {
    data: new SlashCommandBuilder().setName('rank').setDescription('See your level card (or someone else\u2019s)').addUserOption((o) => o.setName('user').setDescription('Whose card? (blank = yours)')),
    handle: (interaction) => levels.rankCard(interaction, interaction.options.getUser('user') || interaction.user),
  },
  {
    data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top members by XP').addIntegerOption((o) => o.setName('page').setDescription('Page number (1 default)').setMinValue(1).setMaxValue(50)),
    handle: (interaction) => levels.leaderboard(interaction, interaction.options.getInteger('page') || 1),
  },
  {
    data: new SlashCommandBuilder().setName('givexp').setDescription('Admin: give XP to someone').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).addIntegerOption((o) => o.setName('amount').setDescription('How much XP').setMinValue(1).setMaxValue(1000000).setRequired(true)),
    handle: async (interaction) => {
      const cfg = context.currentConfig();
      if (!cfg.levels.enabled) return void interaction.reply({ content: 'Levels are disabled.', ephemeral: true }).catch(() => {});
      if (!isAdmin(interaction.member, cfg.general.adminRoleIds)) return void interaction.reply({ content: 'Admins only.', ephemeral: true }).catch(() => {});
      const user = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      const row = db.getXp(interaction.guildId, user.id);
      const career = levels.careerXp(row, cfg.levels.xpBase, cfg.levels.xpGrowth) + amount;
      const newLevel = Math.min(cfg.levels.maxLevel, Schema.levelFromTotalXp(career, cfg.levels.xpBase, cfg.levels.xpGrowth, cfg.levels.maxLevel));
      db.applyXpGain(interaction.guildId, user.id, amount, newLevel, Math.floor(Date.now() / 1000));
      await interaction.reply({ content: `⚡ Gave ${fmtNum(amount)} XP to <@${user.id}> — now level **${newLevel}**.`, allowedMentions: { users: [] } }).catch(() => {});
    },
  },
  {
    data: new SlashCommandBuilder().setName('resetxp').setDescription('Admin: wipe someone\u2019s XP (or everyone\u2019s with `all`)').addUserOption((o) => o.setName('user').setDescription('Who (leave blank + all=true for everyone)')).addBooleanOption((o) => o.setName('all').setDescription('Reset the whole leaderboard')),
    handle: async (interaction) => {
      const cfg = context.currentConfig();
      if (!isAdmin(interaction.member, cfg.general.adminRoleIds)) return void interaction.reply({ content: 'Admins only.', ephemeral: true }).catch(() => {});
      const all = interaction.options.getBoolean('all');
      const user = interaction.options.getUser('user');
      if (!all && !user) return void interaction.reply({ content: 'Pick a user or tick `all`.', ephemeral: true }).catch(() => {});
      db.resetXp(interaction.guildId, all ? undefined : user.id);
      await interaction.reply({ content: all ? '🧹 Leaderboard reset for everyone.' : `🧹 XP reset for <@${user.id}>.`, allowedMentions: { users: [] }, ephemeral: true }).catch(() => {});
    },
  },

  // moderation ----------------------------------------------------------------
  {
    data: new SlashCommandBuilder().setName('warn').setDescription('Warn a member (adds a strike to the ladder)').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    handle: (interaction) => moderation.warn(interaction),
  },
  {
    data: new SlashCommandBuilder().setName('warnings').setDescription('See someone\u2019s strikes').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    handle: (interaction) => moderation.warnings(interaction),
  },
  {
    data: new SlashCommandBuilder().setName('clearwarnings').setDescription('Admin: wipe a member\u2019s strikes').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    handle: (interaction) => moderation.clear(interaction),
  },
];

async function register(client) {
  const cfg = context.currentConfig();
  const body = COMMANDS.map((c) => c.data.toJSON());
  try {
    if (cfg.general.guildId) {
      const guild = client.guilds.cache.get(cfg.general.guildId);
      if (guild) {
        await guild.commands.set(body);
        log(TAG, `${body.length} guild commands registered to ${guild.name}`);
        return;
      }
      log(TAG, 'configured guild not joined yet (check guildId) — registering globally as fallback');
    }
    await client.application.commands.set(body);
    log(TAG, `${body.length} global commands registered (can take up to an hour to appear; guild ones are instant)`);
  } catch (e) {
    log(TAG, `⚠ command registration failed: ${e.message}`);
  }
}

function route(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  const cmd = COMMANDS.find((c) => c.data.name === interaction.commandName);
  if (!cmd) return false;
  Promise.resolve(cmd.handle(interaction)).catch((e) => {
    log(TAG, `⚠ /${interaction.commandName}: ${e.message}`);
    const payload = { content: `Something broke: ${e.message.slice(0, 200)}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.editReply(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  });
  return true;
}

function autocomplete() {} // none yet

module.exports = { COMMANDS, register, route, autocomplete };