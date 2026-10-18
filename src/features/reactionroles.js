/**
 * Reaction roles.
 *
 * Panels come from the dashboard: channel + message (one the bot posts, or an
 * existing message you paste the ID of) + emoji→role bindings. On apply, the
 * bot posts any missing panel messages, makes sure every binding emoji exists
 * as a reaction on the message, and then enforces reacting/granting live.
 *
 * Docs learned: reaction events only fire for uncached (old) messages when
 * Partials.Message/Channel/Reaction are enabled — index.js opts in, and here
 * we fetch() partials before acting (discordjs.guide/legacy/popular-topics/partials).
 */
const { log, err, emojiKey, parseEmoji, toReact, safeSend } = require('../util');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const runtime = require('../runtime');
const context = require('../context');
const theme = require('../theme');

const TAG = 'reactionroles';

// runtime key: reactionPanels = { [guildId]: { [panelName]: messageId } }
function savedMap() {
  return runtime.get('reactionPanels', {});
}

const bindingsByMessage = new Map(); // `${guildId}:${messageId}` → [{emojiKey, roleId}]

function indexBindings(config) {
  bindingsByMessage.clear();
  if (!config.reactionRoles || !config.reactionRoles.enabled) return;
  for (const panel of config.reactionRoles.panels || []) {
    const messageId = panel._messageId;
    if (!messageId) continue;
    const key = `${config.general.guildId}:${messageId}`;
    const list = bindingsByMessage.get(key) || [];
    for (const b of panel.bindings || []) {
      if (b.emoji && b.roleId) list.push({ key: emojiKey(b.emoji), roleId: b.roleId });
    }
    bindingsByMessage.set(key, list);
  }
}

/**
 * The "🎮 — @Java player" list under the panel text. Without it a reaction
 * panel is a row of emoji with nothing saying what they do. Role MENTIONS are
 * used on purpose: inside an embed they render as the role's name and colour
 * and notify nobody.
 */
function legendFor(panel) {
  return (panel.bindings || [])
    .filter((b) => b.emoji && b.roleId)
    .map((b) => `${b.emoji} — <@&${b.roleId}>${b.description ? ` — ${b.description}` : ''}`)
    .join('\n');
}

/** Embed for a panel: your text, then the legend. */
function panelEmbed(panel) {
  const intro = panel.messageContent
    || (panel.style === 'reactions' || !panel.style
      ? 'React below to get a role, un-react to drop it.'
      : 'Pick your roles below.');
  const legend = legendFor(panel);
  return theme.embed(context.getClient(), {
    color: theme.COLORS.primary,
    title: panel.embedTitle || 'Pick your roles',
    description: `${intro}${legend ? `\n\n${legend}` : ''}`.slice(0, 4096),
    footer: 'Reaction roles',
  });
}

/** A button/dropdown label: your description, else the role's own name. */
function labelFor(binding, guild, i) {
  if (binding.description) return binding.description.slice(0, 80);
  const role = guild && guild.roles.cache.get(binding.roleId);
  return (role ? role.name : `Role ${i + 1}`).slice(0, 80);
}

async function ensureMessage(client, guild, panel, guildId) {
  const cfgChannel = panel.channelId;
  if (!cfgChannel) return null;
  try {
    const channel = await guild.channels.fetch(cfgChannel);
    if (!channel || !channel.isTextBased()) {
      err(TAG, `panel ${panel.name}: channel ${cfgChannel} missing`);
      return null;
    }
    let messageId = null;
    if (panel.createMode === 'existing' || panel.messageId) {
      messageId = panel.messageId;
      if (!messageId) {
        err(TAG, `panel ${panel.name}: “use an existing message” needs a message ID`);
        return null;
      }
      // validate that it exists
      try {
        await channel.messages.fetch(messageId);
      } catch {
        err(TAG, `panel ${panel.name}: message ${messageId} not found in that channel`);
        return null;
      }
    } else {
      // bot posts its own; reuse the one from last time
      const saved = savedMap()[guildId] || {};
      messageId = saved[panel.name];
      if (messageId) {
        try {
          await channel.messages.fetch(messageId);
        } catch {
          messageId = null;
        }
      }
      if (!messageId) {
        const msg = await channel.send({ embeds: [panelEmbed(panel)] }).catch((e) => { err(TAG, `posting panel ${panel.name} failed: ${e.message}`); return null; });
        if (!msg) return null;
        messageId = msg.id;
        runtime.set('reactionPanels', { ...savedMap(), [guildId]: { ...(savedMap()[guildId] || {}), [panel.name]: messageId } });
        log(TAG, `panel ${panel.name} posted in #${channel.name} (${messageId})`);
      }
    }
    panel._messageId = messageId;
    return messageId;
  } catch (e) {
    err(TAG, `panel ${panel.name}: ${e.message}`);
    return null;
  }
}

/** Reaction configured on the message so members can click it. Sequential per docs. */
async function ensureReactions(message, panel) {
  const existing = new Set();
  for (const reaction of message.reactions.cache.values()) existing.add(emojiKey(reaction.emoji));
  for (const b of panel.bindings || []) {
    const want = toReact(b.emoji);
    if (!want) continue;
    const key = emojiKey(b.emoji);
    if (existing.has(key)) continue;
    // tolerate variant-selector differences
    let has = [...existing].some((k) => stripFE0F(k) === stripFE0F(key));
    if (has) continue;
    try {
      await message.react(want);
    } catch (e) {
      err(TAG, `react ${b.emoji} failed: ${e.message}`);
    }
  }
}

function stripFE0F(s) {
  return s.replace(/[\uFE0F\u200D]/g, '');
}

async function apply(config) {
  const rr = config.reactionRoles || {};
  if (!config.general.guildId) return;
  const client = context.getClient();
  const guild = client && client.guilds.cache.get(config.general.guildId);
  if (rr.enabled && guild) {
    let idx = 0;
    for (const panel of rr.panels || []) {
      const panelIdx = idx++;
      if (!panel.name || !Array.isArray(panel.bindings)) continue;
      const messageId = await ensureMessage(client, guild, panel, config.general.guildId);
      if (!messageId) continue;
      try {
        const channel = await guild.channels.fetch(panel.channelId);
        const message = await channel.messages.fetch(messageId);
        const components = componentsFor(panel, panelIdx, guild);
        // the legend changes whenever a binding does, so the message body has
        // to be re-rendered too — not just the buttons
        const ours = message.author && client.user && message.author.id === client.user.id;
        if (ours) {
          const print = JSON.stringify([panel.messageContent, panel.embedTitle, panel.style, panel.bindings]);
          const prints = runtime.get('reactionPanelPrint', {});
          if (prints[messageId] !== print) {
            await message.edit({ embeds: [panelEmbed(panel)], components: components || [] })
              .catch((e) => err(TAG, `panel ${panel.name}: edit failed: ${e.message}`));
            runtime.set('reactionPanelPrint', { ...prints, [messageId]: print });
            log(TAG, `panel ${panel.name} updated`);
          }
        } else if (components) {
          await message.edit({ components });
        }
        if (components) {
          if (message.reactions.cache.size) await message.reactions.removeAll().catch(() => {});
        } else {
          await ensureReactions(message, panel);
        }
      } catch (e) {
        err(TAG, `panel ${panel.name}: ${e.message}`);
      }
    }
  }
  indexBindings(config); // always refresh (clears stale entries when disabled)
}

/* ----------------------- component styles (Carl/Sapphire) ------------------ */

const BTN_PREFIX = 'rrb:';
const SEL_PREFIX = 'rrd:';

/** Rows of buttons for a panel (≤25 bindings → 5 rows of 5). */
function buttonRows(panel, panelIdx, guild) {
  const rows = [];
  const list = panel.bindings || [];
  for (let r = 0; r * 5 < Math.min(list.length, 25); r++) {
    const row = new ActionRowBuilder();
    for (let i = r * 5; i < Math.min((r + 1) * 5, list.length, 25); i++) {
      const b = list[i];
      const btn = new ButtonBuilder().setCustomId(`${BTN_PREFIX}${panelIdx}:${i}`).setStyle(ButtonStyle.Primary);
      btn.setLabel(labelFor(b, guild, i));
      const pe = parseEmoji(b.emoji);
      if (pe) btn.setEmoji(pe.id ? { name: pe.name, id: pe.id, animated: pe.animated } : pe.name);
      row.addComponents(btn);
    }
    rows.push(row);
  }
  return rows;
}

function dropdownRows(panel, panelIdx, guild) {
  const opts = (panel.bindings || []).slice(0, 25).map((b, i) => {
    const o = new StringSelectMenuOptionBuilder().setLabel(labelFor(b, guild, i)).setValue(String(i));
    const pe = parseEmoji(b.emoji);
    if (pe) o.setEmoji(pe.id ? { name: pe.name, id: pe.id, animated: pe.animated } : pe.name);
    return o;
  });
  if (!opts.length) return [];
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`${SEL_PREFIX}${panelIdx}`)
      .setPlaceholder('Pick your roles').setMinValues(0).setMaxValues(Math.min(opts.length, 25))
      .addOptions(opts),
  )];
}

/** Components a panel's message should carry for non-reaction styles. */
function componentsFor(panel, panelIdx, guild) {
  const style = panel.style || 'reactions';
  if (style === 'buttons') return buttonRows(panel, panelIdx, guild);
  if (style === 'dropdown') return dropdownRows(panel, panelIdx, guild);
  return null;
}

async function handlePanelButton(interaction) {
  const cfg = context.currentConfig();
  const [, pi, bi] = interaction.customId.split(':');
  const panel = (cfg.reactionRoles.panels || [])[parseInt(pi, 10)];
  const binding = panel && (panel.bindings || [])[parseInt(bi, 10)];
  if (!binding) return void replyOnce(interaction, 'This button no longer matches the configuration.');
  const member = interaction.member;
  if (member.roles.cache.has(binding.roleId)) {
    await member.roles.remove(binding.roleId, 'reaction role (button toggle)').catch((e) => err(TAG, `remove: ${e.message}`));
    return void replyOnce(interaction, `Took away <@&${binding.roleId}>.`);
  }
  await member.roles.add(binding.roleId, 'reaction role (button)').catch((e) => reportRoleError(interaction.guild, `button grant failed: ${e.message}`));
  await replyOnce(interaction, `Gave you <@&${binding.roleId}>.`);
}

async function handlePanelSelect(interaction) {
  const cfg = context.currentConfig();
  const pi = parseInt(interaction.customId.slice(SEL_PREFIX.length), 10);
  const panel = (cfg.reactionRoles.panels || [])[pi];
  if (!panel) return void replyOnce(interaction, 'This menu no longer matches the configuration.');
  const member = interaction.member;
  const wanted = new Set(interaction.values.map((v) => (panel.bindings || [])[parseInt(v, 10)]).filter(Boolean).map((b) => b.roleId));
  for (const b of panel.bindings || []) {
    if (!b.roleId) continue;
    try {
      if (wanted.has(b.roleId) && !member.roles.cache.has(b.roleId)) {
        await member.roles.add(b.roleId, 'reaction role (dropdown)');
      } else if (!wanted.has(b.roleId) && member.roles.cache.has(b.roleId)) {
        await member.roles.remove(b.roleId, 'reaction role (dropdown)');
      }
    } catch (e) {
      reportRoleError(interaction.guild, `dropdown sync failed for <@&${b.roleId}>: ${e.message}`);
    }
  }
  await replyOnce(interaction, `Updated: ${[...wanted].map((id) => `<@&${id}>`).join(', ') || 'no roles'}.`);
}

function replyOnce(interaction, content) {
  const fn = interaction.deferred || interaction.replied ? interaction.followUp : interaction.reply;
  return fn.call(interaction, { content, ephemeral: true }).catch(() => {});
}

/* ------------------------------ gateway events ----------------------------- */

function findBinding(guildId, messageId, emoji) {
  const list = bindingsByMessage.get(`${guildId}:${messageId}`);
  if (!list) return null;
  const key = stripFE0F(emojiKey(emoji));
  return list.find((b) => stripFE0F(b.key) === key) || null;
}

async function register(client) {
  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user.bot) return;
      let ok = true;
      if (reaction.partial) ok = await reaction.fetch().catch(() => false);
      if (ok === false) return;
      const { message } = reaction;
      if (message.partial) await message.fetch().catch(() => null);
      const roleIdGrant = findBinding(message.guildId, message.id, reaction.emoji);
      if (!roleIdGrant) return;
      const guild = client.guilds.cache.get(message.guildId);
      if (!guild) return;
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;
      if (member.roles.cache.has(roleIdGrant.roleId)) return;
      await member.roles.add(roleIdGrant.roleId, `reaction role (${reaction.emoji.name})`).catch((e) => {
        reportRoleError(guild, `could not give <@&${roleIdGrant.roleId}> reacting in <#${message.channel.id}>: ${e.message}`);
      });
      log(TAG, `${user.username} → ${roleIdGrant.roleId}`);
    } catch (e) {
      err(TAG, `add handler: ${e.message}`);
    }
  });

  client.on('interactionCreate', (i) => {
    if (i.isButton() && i.customId.startsWith(BTN_PREFIX)) void handlePanelButton(i).catch((e) => err(TAG, e.message));
    else if (i.isStringSelectMenu() && i.customId.startsWith(SEL_PREFIX)) void handlePanelSelect(i).catch((e) => err(TAG, e.message));
  });

  client.on('messageReactionRemove', async (reaction, user) => {
    try {
      if (user.bot) return;
      let ok = true;
      if (reaction.partial) ok = await reaction.fetch().catch(() => false);
      if (ok === false) return;
      const { message } = reaction;
      if (message.partial) await message.fetch().catch(() => null);
      const binding = findBinding(message.guildId, message.id, reaction.emoji);
      if (!binding) return;
      const cfg = context.currentConfig();
      if (!cfg.reactionRoles || !cfg.reactionRoles.removeOnUnreact) return;
      const guild = client.guilds.cache.get(message.guildId);
      if (!guild) return;
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member || !member.roles.cache.has(binding.roleId)) return;
      await member.roles.remove(binding.roleId, 'reaction role removed').catch((e) => {
        reportRoleError(guild, `could not take <@&${binding.roleId}> un-reacting in <#${message.channel.id}>: ${e.message}`);
      });
      log(TAG, `${user.username} ✕ ${binding.roleId}`);
    } catch (e) {
      err(TAG, `remove handler: ${e.message}`);
    }
  });
}

/** Gone-hierarchy / gone-role errors surface in the log channel (once per cooldown). */
let lastRoleErrorNotice = 0;
function reportRoleError(guild, text) {
  err(TAG, text.replace(/<[^>]+>/g, 'role/channel'));
  const now = Date.now();
  if (now - lastRoleErrorNotice < 5 * 60 * 1000) return;
  lastRoleErrorNotice = now;
  const cfg = context.currentConfig();
  const logId = (cfg.general && cfg.general.logChannelId) || '';
  const ch = logId ? guild.channels.cache.get(logId) : null;
  if (ch && ch.isTextBased()) safeSend(ch, `🔁 Reaction roles: ${text}`, TAG);
}

module.exports = { register, apply, indexBindings, findBinding, legendFor, labelFor };