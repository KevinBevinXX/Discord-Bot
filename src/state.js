/**
 * state.json — a snapshot of the server (channels + roles) written back to the
 * repo so the dashboard can show NAME dropdowns instead of number soup.
 * Written only when GITHUB_TOKEN is configured; the dashboard falls back to
 * ID paste boxes when it is absent.
 */
const context = require('./context');

async function collect(config) {
  const client = context.getClient();
  // prefer the configured guild, else the one we're in (single-server bot)
  const guild = (config.general.guildId && client && client.guilds.cache.get(config.general.guildId))
    || (client ? client.guilds.cache.first() : null);
  if (!guild) return null;

  // refresh the cache so memberCount and edited channels are current
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});


  const channels = guild.channels.cache
    .filter((c) => c.type === 0 || c.type === 5 || c.type === 15 || c.type === 4)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type === 0 ? 'text' : c.type === 5 ? 'announcement' : c.type === 15 ? 'forum' : 'category',
      category: c.parentId || '',
    }))
    .filter((c) => c.type !== 'category')
    .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));

  const roles = guild.roles.cache
    .filter((r) => r.name !== '@everyone')
    .sorted((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, managed: r.managed }));

  return {
    guildId: guild.id,
    guildName: guild.name,
    memberCount: guild.memberCount,
    botId: client.user.id,
    updatedAt: new Date().toISOString(),
    channels,
    roles,
  };
}

module.exports = { collect };