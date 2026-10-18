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
const crypto = require('crypto');
const db = require('../db');
const context = require('../context');
const runtime = require('../runtime');
const { buildTranscriptText } = require('../transcript');
const { fill, hasAnyRole, isAdmin, log, err, displayEmoji, parseEmoji } = require('../util');
const theme = require('../theme');

const TAG = 'tickets';
const IDs = {
  open: 'ticket:open',
  reason: 'ticket:reason',
  claim: 'ticket:claim',
  close: 'ticket:close', // button
  closeModal: 'ticket:closeModal', // modal submit
  delete: 'ticket:delete',
  transcript: 'ticket:transcript', // + ':<ticket number>'
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

/**
 * What apply() should do about the panel message:
 *   nothing saved yet          → post it (first-time setup)
 *   saved and still there      → edit it (and only when it actually changed)
 *   saved, gone, after a save  → post it (the save is the request to send it)
 *   saved, gone, otherwise     → leave it alone; deleting it was deliberate
 */
function panelAction({ savedId, found, repost }) {
  if (!savedId) return 'post';
  if (found) return 'edit';
  return repost ? 'post' : 'skip';
}

/**
 * Keep the panel message in step with the configuration.
 * `opts.repost` marks an apply that came from a dashboard save — the only
 * thing that re-sends a panel someone deleted.
 */
async function apply(config, opts = {}) {
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
  const print = crypto.createHash('sha256').update(JSON.stringify(panel)).digest('hex').slice(0, 16);
  const prints = runtime.get('ticketPanelPrint', {});
  const savedId = runtime.get('ticketPanel', {})[guildId];
  let msg = null;
  if (savedId) {
    // a deleted message answers 404 / JSON error 10008 "Unknown message"
    msg = await channel.messages.fetch(savedId).catch(() => null);
    if (msg && !(msg.author && msg.author.id === client.user.id)) msg = null;
  }
  const action = panelAction({ savedId, found: !!msg, repost: !!opts.repost });
  if (action === 'skip') return;
  if (action === 'edit') {
    if (prints[guildId] !== print) {
      await msg.edit(panel).catch((e) => err(TAG, `panel edit failed: ${e.message}`));
      runtime.set('ticketPanelPrint', { ...prints, [guildId]: print });
      log(TAG, `panel updated in #${channel.name ?? t.panelChannelId}`);
    }
    return;
  }
  try {
    const created = await channel.send(panel);
    runtime.set('ticketPanel', { ...runtime.get('ticketPanel', {}), [guildId]: created.id });
    runtime.set('ticketPanelPrint', { ...runtime.get('ticketPanelPrint', {}), [guildId]: print });
    log(TAG, `panel posted in #${channel.name ?? t.panelChannelId} (${created.id})`);
  } catch (e) {
    err(TAG, `posting panel failed: ${e.message}`);
  }
}

function panelPayload(t) {
  const color = parseInt(String(t.panelColor || '#5865F2').replace('#', ''), 16);
  const client = context.getClient();
  const embed = theme.embed(client, {
    color,
    title: t.panelTitle || 'Need help?',
    description: t.panelText || '',
  });
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDs.open).setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
    )],
  };
}

/**
 * The Claim/Close row. Exactly ONE message per ticket may carry it: the init
 * embed, which is the message every handler edits (db `init_message_id`) — so
 * a second copy also went stale on claim. Two copies is what showed up as
 * "2 claim and close buttons".
 */
function controlsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDs.claim).setLabel('Claim').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(IDs.close).setLabel('Close').setStyle(ButtonStyle.Danger),
  );
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
    else if (i.isButton() && i.customId === IDs.delete) void handleDelete(i);
    else if (i.isButton() && i.customId.startsWith(`${IDs.transcript}:`)) void handleTranscript(i);
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

  // Both lists: the roles for this reason AND the ones pinged in every ticket
  // (that second setting existed on the dashboard but was never read).
  const pingIds = [...new Set([
    ...(Array.isArray(t.pingRoleIds) ? t.pingRoleIds : []),
    ...(Array.isArray(reason.pingRoleIds) ? reason.pingRoleIds : []),
  ])];

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

  const client = context.getClient();
  const embed = theme.embed(client, {
    color: theme.COLORS.success,
    title: `${displayEmoji(reason.emoji) || '🎫'} ${reason.label}`.slice(0, 256),
    description: fill(greetingFor(t, reason), {
      user: `<@${opener.id}>`,
      username: opener.user.username,
      reason: reason.label,
      server: guild.name,
    }),
    fields: [
      { name: 'Opened by', value: `<@${opener.id}>`, inline: true },
      { name: 'Claimed by', value: '—', inline: true },
    ],
  });
  embed.setColor(theme.COLORS.success);

  // One message, not two: the pings ride on this message's CONTENT (a mention
  // inside an embed notifies nobody) while the greeting stays in the embed.
  const mentions = [`<@${opener.id}>`, ...(pingIds || []).map((id) => `<@&${id}>`)].join(' ');
  const initMsg = await channel.send({
    content: mentions.slice(0, 1800),
    embeds: [embed],
    components: [controlsRow()],
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
      .setColor(theme.COLORS.success)
      .spliceFields(1, 1, { name: 'Claimed by', value: `<@${interaction.user.id}>`, inline: true });
    await msg.edit({ embeds: [embed] });
  } catch (e) {
    err(TAG, `claim embed update failed: ${e.message}`);
  }
  await interaction.reply({ content: `✅ Claimed — you now own this ticket.`, ephemeral: true }).catch(() => {});
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

async function handleDelete(interaction) {
  const cfg = require('../context').currentConfig();
  const row = ticketOf(interaction);
  if (!row) return void replyOnce(interaction, 'This channel is not a ticket.');
  if (!isStaff(interaction.member, cfg)) return void replyOnce(interaction, 'Only staff can delete tickets.');
  await interaction.reply({ content: '🗑️ Deleting this channel…', ephemeral: true }).catch(() => {});
  setTimeout(() => interaction.channel.delete(`ticket #${row.number} deleted by ${interaction.user.username}`).catch((e) => err(TAG, `delete failed: ${e.message}`)), 500);
}

/** A reason can carry its own first message; otherwise the ticket default. */
function greetingFor(t, reason) {
  const own = reason && typeof reason.greeting === 'string' ? reason.greeting.trim() : '';
  return own || (t && t.greeting) || 'Ticket for **{reason}**.';
}

/** Best-effort username for the opener, from the messages we already have. */
function closerName(userId, messages) {
  const m = (messages || []).find((x) => x.author && x.author.id === userId);
  return m && m.author ? m.author.username : userId;
}

/**
 * Split on line boundaries so no message cuts mid-line. There is no file to
 * fall back on any more, so this carries the whole transcript across follow-up
 * messages, and only gives up after maxChunks.
 */
function chunkText(text, size = 1900, maxChunks = 6) {
  const out = [];
  let buf = '';
  let truncated = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.length > size ? `${raw.slice(0, size - 1)}…` : raw;
    if (buf && buf.length + 1 + line.length > size) {
      out.push(buf);
      buf = '';
      if (out.length === maxChunks) { truncated = true; break; }
    }
    buf = buf ? `${buf}\n${line}` : line;
  }
  if (!truncated && buf) out.push(buf);
  if (truncated) out[out.length - 1] += '\n…(transcript truncated)';
  if (!out.length) out.push('(empty transcript)');
  return out;
}

async function handleTranscript(interaction) {
  const number = parseInt(interaction.customId.split(':')[2], 10);
  const row = Number.isFinite(number) ? db.ticketByNumber(interaction.guildId, number) : null;
  if (!row || !row.transcriptText) {
    return void replyOnce(interaction, 'No transcript stored for that ticket (it was closed before transcripts were kept).');
  }
  // parse: [] so quoting someone's message cannot ping them all over again
  const chunks = chunkText(row.transcriptText);
  const opts = { ephemeral: true, allowedMentions: { parse: [] } };
  await interaction.reply({ content: chunks[0], ...opts })
    .catch((e) => err(TAG, `transcript reply failed: ${e.message}`));
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, ...opts }).catch(() => {});
  }
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
      db.updateTicket(guild.id, channel.id, {
        transcript_text: buildTranscriptText({
          guild: guild.name,
          ticketNumber: row.number,
          reason: row.reason,
          openedBy: closerName(row.userId, messages),
          closedBy: closer.user ? closer.user.username : 'system',
          closeReason: reasonText,
          messages,
        }).slice(0, 200000),
      });

      const target = await resolveChannel(client, guild.id, t.logChannelId || cfg.general.logChannelId);
      if (target) {
        const logEmbed = theme.embed(context.getClient(), {
          color: theme.COLORS.success,
          title: 'Ticket Closed',
          fields: [
            { name: '🎟️ Ticket ID', value: `${row.number}`, inline: true },
            { name: '🟢 Opened By', value: `<@${row.userId}>`, inline: true },
            { name: '🔴 Closed By', value: `<@${closer.id}>`, inline: true },
            { name: '🕐 Open Time', value: `<t:${row.createdAt}:f>`, inline: true },
            { name: '🙋 Claimed By', value: row.claimedBy ? `<@${row.claimedBy}>` : 'Not claimed', inline: true },
            { name: '❓ Reason', value: (row.reason || 'No reason specified').slice(0, 1024), inline: true },
            ...(reasonText ? [{ name: '📝 Close reason', value: reasonText.slice(0, 1024), inline: false }] : []),
          ],
        });
        // No file: spoilering it did not stop Discord unrolling the markup,
        // it only put SPOILER_ in the name. The transcript lives behind the
        // button, as plain lines.
        const sent = await target.send({
          embeds: [logEmbed],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${IDs.transcript}:${row.number}`)
              .setLabel('View transcript')
              .setEmoji('📄')
              .setStyle(ButtonStyle.Secondary),
          )],
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
      .setColor(theme.COLORS.neutral)
      .addFields(
        { name: 'Status', value: '🔒 Closed', inline: true },
        { name: 'Closed by', value: `<@${closer.id}>`, inline: true },
        { name: 'Close reason', value: reasonText ? reasonText.slice(0, 1000) : '—', inline: false },
      );
    await msg.edit({ embeds: [embed], components: [] });
  } catch { /* init message may be gone */ }

  // closed tickets are always removed — the transcript (log channel + DM) is the record
  log(TAG, `ticket #${row.number} deleting channel in 10s`);
  setTimeout(() => channel.delete(`ticket #${row.number} closed`).catch(() => {}), 10_000);
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

function replyOnce(interaction, content) {
  const fn = interaction.deferred || interaction.replied ? interaction.followUp : interaction.reply;
  return fn.call(interaction, { content, ephemeral: true }).catch(() => {});
}

module.exports = { register, apply, closeTicket, controlsRow, chunkText, panelAction, greetingFor, IDs };