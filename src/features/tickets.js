/**
 * Tickets.
 *
 * Flow (mirrors Carl/Tickets bots, configured from the dashboard):
 *   panel message → user opens a ticket → ephemeral dropdown of the reasons
 *   you_defined → a private channel `ticket-0007` is created with permission
 *   overwrites → staff can Claim; opener or staff can Close, which always asks
 *   for a (optional) reason via a modal → transcript is posted to the log
 *   channel, the opener gets a DM, and the channel is archived or deleted.
 *   Closed tickets get [Reopen]/[Delete] buttons.
 */
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const db = require('../db');
const runtime = require('../runtime');
const { buildTranscriptHtml } = require('../transcript');
const { fill, hasAnyRole, isAdmin, log, err, displayEmoji, parseEmoji } = require('../util');

const TAG = 'tickets';
const IDs = {
  open: 'ticket:open',
  reason: 'ticket:reason',
  claim: 'ticket:claim',
  close: 'ticket:close', // button
  closeModal: 'ticket:closeModal', // modal submit
  reopen: 'ticket:reopen',
  delete: 'ticket:delete',
};

let client = null;
let AUTO_CLOSE_TICK_MS = 15 * 60 * 1000;
let autoCloseTimer = null;

async function resolveChannel(client_, guildId, channelId) {
  if (!channelId) return null;
  const guild = client_.guilds.cache.get(guildId);
  if (!guild) return null;
  try {
    const ch = await guild.channels.fetch(channelId);
    return ch && ch.isTextBased() ? ch : null;
  } catch {
    return null;
  }
}

/** Keep the panel message in step with the configuration. */
async function apply(config) {
  const t = config.tickets || {};
  const guildId = config.general ? config.general.guildId : '';
  if (!client) return;
  if (!t.enabled || !t.panelChannelId || !guildId) return;
  const channel = await resolveChannel(client, guildId, t.panelChannelId);
  if (!channel) {
    err(TAG, `panel channel ${t.panelChannelId} not found (create it, then save again)`);
    return;
  }
  const panel = panelPayload(t);
  const savedId = runtime.get('ticketPanel', {})[guildId];
  if (savedId) {
    try {
      const msg = await channel.messages.fetch(savedId);
      if (msg.author && msg.author.id === client.user.id) {
        await msg.edit(panel);
        return;
      }
    } catch {
      // message gone — fall through and create a new one
    }
  }
  try {
    const created = await channel.send(panel);
    runtime.set('ticketPanel', { ...runtime.get('ticketPanel', {}), [guildId]: created.id });
    log(TAG, `panel posted in #${channel.name ?? t.panelChannelId} (${created.id})`);
  } catch (e) {
    err(TAG, `posting panel failed: ${e.message}`);
  }
}

function panelPayload(t) {
  const color = parseInt(String(t.panelColor || '#5865F2').replace('#', ''), 16);
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(t.panelTitle || 'Need help?')
    .setDescription((t.panelText || '').slice(0, 4000));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDs.open).setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
    )],
  };
}

function isStaff(member, cfg) {
  if (!member) return false;
  if (member.permissions && member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return isAdmin(member, cfg.general.adminRoleIds) || hasAnyRole(member, cfg.tickets.claimRoleIds);
}

async function register(client_) {
  client = client_;
  client.on('interactionCreate', (i) => {
    if (i.isButton() && i.customId === IDs.open) void handleOpenButton(i);
    else if (i.isStringSelectMenu() && i.customId === IDs.reason) void handleReasonSelect(i);
    else if (i.isButton() && i.customId === IDs.claim) void handleClaim(i);
    else if (i.isButton() && i.customId === IDs.close) void handleCloseButton(i);
    else if (i.isModalSubmit() && i.customId === IDs.closeModal) void handleCloseModal(i);
    else if (i.isButton() && i.customId === IDs.reopen) void handleReopen(i);
    else if (i.isButton() && i.customId === IDs.delete) void handleDelete(i);
  });
  autoCloseTimer = setInterval(() => void sweepAutoClose(), AUTO_CLOSE_TICK_MS);
  autoCloseTimer.unref();
}

/* ---------------------------------- open ---------------------------------- */

async function handleOpenButton(interaction) {
  const cfg = require('../context').currentConfig();
  const t = cfg.tickets;
  if (!cfg.general.guildId || interaction.guildId !== cfg.general.guildId) return;
  if (!t.enabled) return void replyOnce(interaction, 'Tickets are currently disabled.');
  const reasons = (t.reasons || []).filter((r) => r.label);
  if (!reasons.length) return void replyOnce(interaction, 'No ticket reasons are configured yet — an admin needs to add them on the dashboard.');

  const options = reasons.slice(0, 25).map((r, idx) => {
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(r.label)
      .setValue(String(idx));
    if (r.description) opt.setDescription(r.description);
    if (r.emoji) {
      const pe = parseEmoji(r.emoji);
      if (pe) opt.setEmoji(pe.id ? { name: pe.name, id: pe.id, animated: pe.animated } : pe.name);
    }
    return opt;
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(IDs.reason)
    .setPlaceholder('Why are you opening a ticket?')
    .addOptions(options);
  await interaction.reply({
    content: 'Pick the reason that fits best:',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  }).catch((e) => err(TAG, `open reply failed: ${e.message}`));
}

async function handleReasonSelect(interaction) {
  const cfg = require('../context').currentConfig();
  if (interaction.guildId !== cfg.general.guildId) return;
  const t = cfg.tickets || {};
  const idx = parseInt(interaction.values[0], 10);
  const reason = (t.reasons || [])[idx];
  if (!reason) return void replyOnce(interaction, 'That reason no longer exists — try the button again.');

  // Respect the panel's own role pings (both global and per-reason)
  const pingIds = Array.isArray(reason.pingRoleIds) ? reason.pingRoleIds : [];

  if (t.maxOpenPerUser > 0) {
    const open = db.openTicketCount(cfg.general.guildId, interaction.user.id);
    if (open >= t.maxOpenPerUser) {
      return void replyOnce(interaction, `You already have ${open} open ticket${open === 1 ? '' : 's'} — close one before opening another.`);
    }
  }

  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  try {
    const channel = await createTicketChannel(interaction.guild, interaction.member, reason, pingIds, cfg);
    await interaction.editReply(`Ticket opened: ${channel}`).catch(() => {});
    const mentions = [`${interaction.user}`, ...pingIds.map((id) => `<@&${id}>`)].join(' ');
    await channel.send({
      content: `${mentions}`.slice(0, 1800),
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDs.claim).setLabel('Claim').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(IDs.close).setLabel('Close').setStyle(ButtonStyle.Danger),
      )],
    });
  } catch (e) {
    err(TAG, `creating ticket failed: ${e.message}`);
    await interaction.editReply(`I could not create the ticket — check my permissions in that category. (${e.message.slice(0, 150)})`).catch(() => {});
  }
}

async function ensureCategory(guild, name) {
  if (!name) return null;
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (existing) return existing;
  try {
    return await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
    });
  } catch (e) {
    err(TAG, `creating category ${name} failed: ${e.message}`);
    return null;
  }
}

async function createTicketChannel(guild, opener, reason, pingIds, cfg) {
  const t = cfg.tickets;
  const number = db.nextTicketNumber(cfg.general.guildId);
  const name = `ticket-${String(number).padStart(4, '0')}`;
  const me = guild.members.me;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: opener.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory],
    },
    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
  ];
  for (const roleId of t.claimRoleIds || []) overwrites.push({
    id: roleId,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory],
  });

  const parent = await ensureCategory(guild, t.categoryName || 'Tickets');
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent ? parent.id : undefined,
    topic: `Ticket #${number} · opened by ${opener.user.username} · reason: ${reason.label}`,
    permissionOverwrites: overwrites,
  });

  db.createTicketRow(cfg.general.guildId, channel.id, number, opener.id, reason.label, Math.floor(Date.now() / 1000));

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${displayEmoji(reason.emoji) || '🎫'} ${reason.label}`.slice(0, 250))
    .setDescription(fill(t.greeting || 'Ticket for **{reason}**.', {
      user: `<@${opener.id}>`,
      username: opener.user.username,
      reason: reason.label,
      server: guild.name,
    }))
    .addFields(
      { name: 'Opened by', value: `<@${opener.id}>`, inline: true },
      { name: 'Claimed by', value: '—', inline: true },
    )
    .setFooter({ text: `Ticket #${number}` })
    .setTimestamp(new Date());

  const initMsg = await channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDs.claim).setLabel('Claim').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(IDs.close).setLabel('Close').setStyle(ButtonStyle.Danger),
    )],
  });
  db.updateTicket(cfg.general.guildId, channel.id, { init_message_id: initMsg.id });
  return channel;
}

/* ------------------------------- interactions ------------------------------ */

function ticketOf(interaction) {
  return db.ticketByChannel(interaction.guildId, interaction.channelId);
}

async function handleClaim(interaction) {
  const cfg = require('../context').currentConfig();
  const row = ticketOf(interaction);
  if (!row || row.status !== 'open') return void replyOnce(interaction, 'This channel is not an open ticket.');
  if (!isStaff(interaction.member, cfg)) return void replyOnce(interaction, 'Only staff can claim tickets.');

  db.updateTicket(interaction.guildId, interaction.channelId, { claimed_by: interaction.user.id });
  try {
    const msg = await interaction.channel.messages.fetch(row.initMessageId);
    const embed = EmbedBuilder.from(msg.embeds[0])
      .spliceFields(1, 1, { name: 'Claimed by', value: `<@${interaction.user.id}>`, inline: true });
    await msg.edit({ embeds: [embed] });
  } catch (e) {
    err(TAG, `claim embed update failed: ${e.message}`);
  }
  await interaction.reply({ content: `✅ Claimed — you now own this ticket.`, ephemeral: true }).catch(() => {});
  logToChannel(cfg, `🙋 ${interaction.user.username} claimed ticket #${row.number}.`);
}

async function handleCloseButton(interaction) {
  const cfg = require('../context').currentConfig();
  const row = ticketOf(interaction);
  if (!row || row.status !== 'open') return void replyOnce(interaction, 'This ticket is already closed.');
  const allowed = interaction.user.id === row.userId || isStaff(interaction.member, cfg);
  if (!allowed) return void replyOnce(interaction, 'Only the ticket opener or staff can close this.');

  const modal = new ModalBuilder()
    .setCustomId(IDs.closeModal)
    .setTitle('Close ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Why is this ticket being closed? (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000),
      ),
    );
  await interaction.showModal(modal).catch((e) => err(TAG, `showModal failed: ${e.message}`));
}

async function handleCloseModal(interaction) {
  const cfg = require('../context').currentConfig();
  const reason = interaction.fields.getTextInputValue('reason').trim();
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  await closeTicket(interaction.guild, interaction.channel, interaction.member, reason, cfg);
  await interaction.editReply('Ticket closed.').catch(() => {});
}

async function handleReopen(interaction) {
  const cfg = require('../context').currentConfig();
  const row = ticketOf(interaction);
  if (!row) return void replyOnce(interaction, 'This channel is not a ticket.');
  if (row.status !== 'closed') return void replyOnce(interaction, 'This ticket is not closed.');
  if (!isStaff(interaction.member, cfg)) return void replyOnce(interaction, 'Only staff can reopen tickets.');

  db.updateTicket(interaction.guildId, interaction.channelId, { status: 'open', closed_at: 0, close_reason: '' });
  const t = cfg.tickets;
  const parent = t.categoryName ? interaction.guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === t.categoryName) : null;
  const newName = interaction.channel.name.replace(/-closed$/, '');
  await interaction.channel.edit({ name: newName, parent: parent ? parent.id : undefined }).catch((e) => err(TAG, `reopen edit failed: ${e.message}`));
  try {
    const msg = await interaction.channel.messages.fetch(row.initMessageId);
    await msg.edit({ components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDs.claim).setLabel('Claim').setStyle(ButtonStyle.Success).setDisabled(row.claimedBy !== ''),
      new ButtonBuilder().setCustomId(IDs.close).setLabel('Close').setStyle(ButtonStyle.Danger),
    )] });
  } catch { /* init message may be gone */ }
  await interaction.reply({ content: '🔄 Ticket reopened.', ephemeral: true }).catch(() => {});
  logToChannel(cfg, `🔄 ${interaction.user.username} reopened ticket #${row.number}.`);
}

async function handleDelete(interaction) {
  const cfg = require('../context').currentConfig();
  const row = ticketOf(interaction);
  if (!row) return void replyOnce(interaction, 'This channel is not a ticket.');
  if (!isStaff(interaction.member, cfg)) return void replyOnce(interaction, 'Only staff can delete tickets.');
  await interaction.reply({ content: '🗑️ Deleting this channel…', ephemeral: true }).catch(() => {});
  setTimeout(() => interaction.channel.delete(`ticket #${row.number} deleted by ${interaction.user.username}`).catch((e) => err(TAG, `delete failed: ${e.message}`)), 500);
}

/* --------------------------------- closing -------------------------------- */

async function closeTicket(guild, channel, closer, reasonText, cfg) {
  const t = cfg.tickets;
  const row = ticketOfGuild(guild.id, channel.id);
  if (!row || row.status !== 'open') return false;
  const nowSec = Math.floor(Date.now() / 1000);
  db.updateTicket(guild.id, channel.id, { status: 'closed', closed_at: nowSec, close_reason: reasonText });

  // transcript (before anything disappears)
  let transcriptUrlNote = '';
  if (t.transcripts) {
    try {
      const messages = await fetchAllMessages(channel, 500);
      const html = buildTranscriptHtml({
        guild: guild.name,
        channel: channel.name,
        ticketNumber: row.number,
        reason: row.reason,
        openedBy: row.userId,
        closedBy: closer.user ? closer.user.username : 'system',
        closeReason: reasonText,
        messages,
      });
      const target = await resolveChannel(client, guild.id, t.logChannelId || cfg.general.logChannelId);
      if (target) {
        const buf = Buffer.from(html, 'utf8');
        const sent = await target.send({
          content: `📄 Ticket **#${row.number}** (${row.reason}) — opened by <@${row.userId}>, closed by <@${closer.id}>` + (reasonText ? ` — reason: ${reasonText}` : ''),
          files: [{ attachment: buf, name: `ticket-${String(row.number).padStart(4, '0')}-transcript.html` }],
        }).catch((e) => { err(TAG, `transcript send failed: ${e.message}`); return null; });
        if (sent) transcriptUrlNote = sent.url;
      }
    } catch (e) {
      err(TAG, `transcript build failed: ${e.message}`);
    }
  }

  // DM the opener
  if (t.dmUserOnClose) {
    const lines = [
      `Your ticket **#${row.number}** in **${guild.name}** (${row.reason}) was closed by <@${closer.id}>.`,
      reasonText ? `Reason: ${reasonText}` : '',
      transcriptUrlNote ? `Transcript: ${transcriptUrlNote}` : '',
    ].filter(Boolean).join('\n');
    const user = await client.users.fetch(row.userId).catch(() => null);
    if (user) await user.send(lines.slice(0, 1900)).catch(() => {});
  }

  // update the init embed + buttons
  try {
    const msg = await channel.messages.fetch(row.initMessageId);
    const embed = EmbedBuilder.from(msg.embeds[0])
      .setColor(0x7f8c8d)
      .addFields(
        { name: 'Status', value: '🔒 Closed', inline: true },
        { name: 'Closed by', value: `<@${closer.id}>`, inline: true },
        { name: 'Close reason', value: reasonText ? reasonText.slice(0, 1000) : '—', inline: false },
      );
    await msg.edit({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDs.reopen).setLabel('Reopen').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDs.delete).setLabel('Delete channel').setStyle(ButtonStyle.Danger),
      )],
    });
  } catch { /* init message may be gone */ }

  // archive or delete
  const closedCat = (t.closedCategoryName || '').trim();
  if (closedCat) {
    await channel.setName(`${channel.name}-closed`.slice(0, 100)).catch(() => {});
    const cat = await ensureCategory(guild, closedCat);
    if (cat) await channel.setParent(cat.id, { lockPermissions: false }).catch((e) => err(TAG, `archive move failed: ${e.message}`));
    log(TAG, `ticket #${row.number} archived to ${closedCat}`);
  } else {
    log(TAG, `ticket #${row.number} deleting channel in 10s`);
    setTimeout(() => channel.delete(`ticket #${row.number} closed`).catch(() => {}), 10_000);
  }
  logToChannel(cfg, `🔒 Ticket #${row.number} closed by ${closer.user ? closer.user.username : closer.id}` + (reasonText ? ` — “${reasonText.slice(0, 200)}”` : ''));
  return true;
}

function ticketOfGuild(guildId, channelId) {
  return db.ticketByChannel(guildId, channelId);
}

async function fetchAllMessages(channel, max) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const arr = [...batch.values()];
    if (!arr.length) break;
    out.push(...arr);
    before = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }
  return out.slice(0, max);
}

/* --------------------------------- sweep ---------------------------------- */

async function sweepAutoClose() {
  if (!client || !client.isReady()) return;
  const cfg = require('../context').currentConfig();
  const t = cfg.tickets;
  if (!t.enabled || !t.autoCloseHours || !cfg.general.guildId) return;
  const guild = client.guilds.cache.get(cfg.general.guildId);
  if (!guild) return;
  const cutoff = Date.now() - t.autoCloseHours * 3600 * 1000;
  for (const row of db.openTickets(cfg.general.guildId)) {
    const channel = await resolveChannel(client, guild.id, row.channelId).catch(() => null);
    if (!channel) continue;
    let lastAt = row.createdAt * 1000;
    try {
      if (channel.lastMessageId) {
        const last = await channel.messages.fetch(channel.lastMessageId).catch(() => null);
        if (last) lastAt = last.createdTimestamp;
      }
    } catch { /* keep created_at */ }
    if (lastAt < cutoff) {
      log(TAG, `auto-closing ticket #${row.number} (silent for ${t.autoCloseHours}h)`);
      await closeTicket(guild, channel, guild.members.me, `auto-close: no activity for ${t.autoCloseHours}h`, cfg);
    }
  }
}

/* -------------------------------- utilities ------------------------------- */

function logToChannel(cfg, content) {
  const target = (cfg.tickets.logChannelId || cfg.general.logChannelId);
  if (!target || !client) return;
  const guild = client.guilds.cache.get(cfg.general.guildId);
  if (!guild) return;
  const ch = guild.channels.cache.get(target);
  if (ch && ch.isTextBased()) ch.send(content.slice(0, 1900)).catch(() => {});
}

function replyOnce(interaction, content) {
  const fn = interaction.deferred || interaction.replied ? interaction.followUp : interaction.reply;
  return fn.call(interaction, { content, ephemeral: true }).catch(() => {});
}

module.exports = { register, apply, closeTicket, IDs };