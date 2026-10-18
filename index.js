/**
 * KBX Community Bot — entrypoint.
 *
 * Wires: client (intents + partials) → config sync → features → commands.
 * Config comes from the dashboard repo (config.json) and hot-reloads.
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const context = require('./src/context');
const configModule = require('./src/config');
const db = require('./src/db');
const runtime = require('./src/runtime');
const state = require('./src/state');
const commands = require('./src/commands');
const tickets = require('./src/features/tickets');
const reactionRoles = require('./src/features/reactionroles');
const levels = require('./src/features/levels');
const automod = require('./src/features/automod');
const welcome = require('./src/features/welcome');
const { log, err } = require('./src/util');

const BOT_NAME = "KBX Community Bot";

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and paste the bot token (Discord Developer Portal → Bot → Reset Token).');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,        // welcome/autorole — enable in dev portal!
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,      // automod + XP need content — enable in dev portal!
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction], // reaction roles on old messages
});

context.setClient(client);
db.init();
runtime.load();

let ready = false;

configModule.onConfigApplied(async (cfg, { first, source }) => {
  context.setConfig(cfg);
  if (!ready) return; // ready-path applies features once we know the guild; until then just keep the config current
  try {
    // a save is the one thing that re-sends a panel someone deleted
    await tickets.apply(cfg, { repost: !first });
    await reactionRoles.apply(cfg);
  } catch (e) {
    err('config', `applying config failed: ${e.message}`);
  }
  if (!first) log('config', `→ features re-applied (source: ${source})`);
});

client.once(Events.ClientReady, async (c) => {
  log('boot', `${BOT_NAME} online as ${c.user.tag} — ${c.guilds.cache.size} guild(s)`);
  await tickets.register(c);        // wires ticket buttons/modals + gives apply() its client
  await reactionRoles.register(c);  // wires reaction + button/dropdown role handlers
  await commands.register(c);
  const cfg = configModule.get();
  context.setConfig(cfg);
  ready = true;
  await tickets.apply(cfg);
  await reactionRoles.apply(cfg);

  levels.startVoiceTicker(c);
  // server snapshot for the dashboard's channel/role pickers (10-minute cadence)
  configModule.pushStateCollector(() => state.collect(configModule.get()));
  setInterval(() => void configModule.reload(), 10 * 60 * 1000).unref();
  // deliberately no re-posting sweep: a panel you delete stays deleted until
  // you save from the dashboard

  log('boot', 'features applied (tickets panel, reaction roles, auto-close timers)');
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.guild && message.member) {
      const hit = await automod.handleMessage(message);
      if (!hit) await levels.handleMessage(message);
    }
  } catch (e) {
    err('message', e);
  }
});

client.on(Events.GuildMemberAdd, (member) => welcome.onJoin(member).catch((e) => err('welcome', e)));
client.on(Events.GuildMemberRemove, (member) => welcome.onLeave(member).catch((e) => err('welcome', e)));

client.on(Events.InteractionCreate, (interaction) => {
  try {
    if (commands.route(interaction)) return;
  } catch (e) {
    err('commands', e);
  }
});

client.on(Events.Error, (e) => err('client', e));
process.on('unhandledRejection', (e) => err('unhandled', e));

configModule.start();
client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('login failed:', e.message);
  if (/disallowed intents/i.test(e.message)) {
    console.error('→ Enable BOTH "Server Members Intent" and "Message Content Intent" in the Developer Portal → Bot page.');
  }
  process.exit(1);
});