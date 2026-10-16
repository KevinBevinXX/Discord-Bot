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
const runtime = require('../runtime');
const context = require('../context');

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
        const parts = [panel.messageContent || ''];
        const msg = await channel.send({
          content: (panel.messageContent || `React below for roles! (${panel.name})`).slice(0, 2000),
          embeds: panel.embedTitle ? [{ title: panel.embedTitle }] : [],
        }).catch((e) => { err(TAG, `posting panel ${panel.name} failed: ${e.message}`); return null; });
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
    for (const panel of rr.panels || []) {
      if (!panel.name || !Array.isArray(panel.bindings)) continue;
      const messageId = await ensureMessage(client, guild, panel, config.general.guildId);
      if (!messageId) continue;
      try {
        const channel = await guild.channels.fetch(panel.channelId);
        const message = await channel.messages.fetch(messageId);
        await ensureReactions(message, panel);
      } catch (e) {
        err(TAG, `panel ${panel.name}: ${e.message}`);
      }
    }
  }
  indexBindings(config); // always refresh (clears stale entries when disabled)
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

module.exports = { register, apply, indexBindings, findBinding };