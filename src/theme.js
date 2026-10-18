/**
 * One visual identity for every message this bot posts — embeds share the
 * same colours, footer and shape, whether it's a ticket, a level-up or a
 * mod-log entry. The dashboard (/docs) uses the same palette vars so the
 * website and the server read as one product.
 */
const { EmbedBuilder } = require('discord.js');

const BRAND = "KBX Community Bot";

const COLORS = {
  primary: 0x5865f2,   // blurple — tickets panel, rank cards, neutral info
  success: 0x23c55e,   // green — welcomes, grants, claims
  warn: 0xf0b232,      // amber — strikes, warnings, timeouts
  danger: 0xed4245,    // red — auto-mod hits, bans/kicks, deletions
  neutral: 0x95a0b8,   // gray-blue — closed/archived, goodbyes
};

/**
 * Pre-styled builder: brand footer (bot avatar as the icon when known) +
 * timestamp. Pass `footer: false` for neither — Discord renders the footer
 * text and the timestamp as one line, so a message that should end on its own
 * words has to drop both.
 */
function embed(client, { color = COLORS.primary, title, description, fields = [], footer } = {}) {
  const icon = client && client.user ? client.user.displayAvatarURL({ size: 64, extension: 'png' }) : undefined;
  const e = new EmbedBuilder().setColor(color);
  if (footer !== false) e.setTimestamp();
  if (title) e.setTitle(String(title).slice(0, 256));
  if (description) e.setDescription(String(description).slice(0, 4096));
  if (fields.length) e.addFields(fields.map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024) || '\u200b', inline: !!f.inline })));
  if (footer !== false) e.setFooter({ text: footer ? `${BRAND} · ${footer}` : BRAND, ...(icon ? { iconURL: icon } : {}) });
  return e;
}

function success(client, opts) { return embed(client, { ...opts, color: COLORS.success }); }
function warn(client, opts) { return embed(client, { ...opts, color: COLORS.warn }); }
function error(client, opts) { return embed(client, { ...opts, color: COLORS.danger }); }
function neutral(client, opts) { return embed(client, { ...opts, color: COLORS.neutral }); }

module.exports = { BRAND, COLORS, embed, success, warn, error, neutral };