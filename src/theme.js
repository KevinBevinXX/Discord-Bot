/**
 * One visual identity for every message this bot posts — embeds share the
 * same colours and shape, whether it's a ticket, a level-up or a
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
 * Pre-styled builder: one palette and shape for every embed.
 *
 * No footer and no timestamp. Discord renders them as a single grey
 * "KBX Community Bot · <text> • <time>" line under the message, which says
 * nothing a reader does not already know — messages end on their own words.
 * Anything worth reading belongs in the description or a field.
 * (`client` is kept in the signature for the call sites; nothing needs it.)
 */
function embed(client, { color = COLORS.primary, title, description, fields = [] } = {}) {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(String(title).slice(0, 256));
  if (description) e.setDescription(String(description).slice(0, 4096));
  if (fields.length) e.addFields(fields.map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024) || '\u200b', inline: !!f.inline })));
  return e;
}

function success(client, opts) { return embed(client, { ...opts, color: COLORS.success }); }
function warn(client, opts) { return embed(client, { ...opts, color: COLORS.warn }); }
function error(client, opts) { return embed(client, { ...opts, color: COLORS.danger }); }
function neutral(client, opts) { return embed(client, { ...opts, color: COLORS.neutral }); }

module.exports = { BRAND, COLORS, embed, success, warn, error, neutral };