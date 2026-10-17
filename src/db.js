/**
 * Persistence. node:sqlite is built into Node 24+, so no native dependency.
 * WAL mode + a single connection. Everything is per (guild, user) so the bot
 * could be invited to several servers without cross-talk.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { log } = require('./util');

const DB_PATH = path.join(process.cwd(), 'data', 'bot.db');

let db;

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS xp (
      guild_id  TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      xp        INTEGER NOT NULL DEFAULT 0,
      level     INTEGER NOT NULL DEFAULT 0,
      messages  INTEGER NOT NULL DEFAULT 0,
      last_xp_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS strikes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      source   TEXT NOT NULL,                -- 'automod:<rule>' or 'command'
      reason   TEXT NOT NULL DEFAULT '',
      moderator_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS strikes_guild_user ON strikes (guild_id, user_id);
    CREATE TABLE IF NOT EXISTS tickets (
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      number      INTEGER NOT NULL,
      user_id     TEXT NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      claimed_by  TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'open',
      close_reason TEXT NOT NULL DEFAULT '',
      init_message_id TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      closed_at   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, channel_id)
    );
    CREATE INDEX IF NOT EXISTS tickets_guild_status ON tickets (guild_id, status);
  `);
  // added after the table shipped: the plain-text transcript the "View
  // transcript" button replies with (the ticket channel is gone by then)
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  if (!cols.includes('transcript_text')) {
    db.exec("ALTER TABLE tickets ADD COLUMN transcript_text TEXT NOT NULL DEFAULT ''");
    log('db', 'migrated: tickets.transcript_text');
  }
  log('db', `ready at ${DB_PATH}`);
}

// --- XP ---------------------------------------------------------------------
function getXp(guildId, userId) {
  const row = db.prepare('SELECT xp, level, messages, last_xp_at FROM xp WHERE guild_id=? AND user_id=?').get(guildId, userId);
  return row ? { xp: Number(row.xp), level: Number(row.level), messages: Number(row.messages), lastXpAt: Number(row.last_xp_at) } : { xp: 0, level: 0, messages: 0, lastXpAt: 0 };
}

function applyXpGain(guildId, userId, gained, newLevel, nowSec) {
  db.prepare(`
    INSERT INTO xp (guild_id, user_id, xp, level, messages, last_xp_at)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      xp = xp + excluded.xp,
      level = excluded.level,
      messages = messages + 1,
      last_xp_at = excluded.last_xp_at
  `).run(guildId, userId, gained, newLevel, nowSec);
}

function leaderboard(guildId, limit, offset) {
  return db.prepare(`
    SELECT user_id, xp, level, messages FROM xp WHERE guild_id=?
    ORDER BY (level * 1000000000 + xp) DESC LIMIT ? OFFSET ?
  `).all(guildId, limit, offset).map((r) => ({ userId: r.user_id, xp: Number(r.xp), level: Number(r.level), messages: Number(r.messages) }));
}

function leaderboardRank(guildId, userId) {
  const row = db.prepare(`
    SELECT n FROM (
      SELECT user_id, ROW_NUMBER() OVER (
        ORDER BY (level * 1000000000 + xp) DESC
      ) AS n FROM xp WHERE guild_id=?
    ) WHERE user_id=?
  `).get(guildId, userId);
  return row ? Number(row.n) : 0;
}

function totalTracked(guildId) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM xp WHERE guild_id=?').get(guildId);
  return Number(r.n);
}

function resetXp(guildId, userId) {
  if (userId) db.prepare('DELETE FROM xp WHERE guild_id=? AND user_id=?').run(guildId, userId);
  else db.prepare('DELETE FROM xp WHERE guild_id=?').run(guildId);
}

// --- strikes ----------------------------------------------------------------
function addStrike(guildId, userId, source, reason, moderatorId, nowSec) {
  db.prepare('INSERT INTO strikes (guild_id, user_id, source, reason, moderator_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, userId, source, reason || '', moderatorId || '', nowSec);
}

function strikeCount(guildId, userId) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM strikes WHERE guild_id=? AND user_id=?').get(guildId, userId);
  return Number(r.n);
}

function strikesFor(guildId, userId, limit = 20) {
  return db.prepare('SELECT id, source, reason, moderator_id, created_at FROM strikes WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT ?')
    .all(guildId, userId, limit)
    .map((r) => ({ id: Number(r.id), source: r.source, reason: r.reason, moderatorId: r.moderator_id, createdAt: Number(r.created_at) }));
}

function clearStrikes(guildId, userId) {
  return Number(db.prepare('DELETE FROM strikes WHERE guild_id=? AND user_id=?').run(guildId, userId).changes);
}

// --- tickets ----------------------------------------------------------------
function nextTicketNumber(guildId) {
  const r = db.prepare('SELECT MAX(number) AS m FROM tickets WHERE guild_id=?').get(guildId);
  return (r && r.m ? Number(r.m) : 0) + 1;
}

function createTicketRow(guildId, channelId, number, userId, reason, nowSec) {
  db.prepare('INSERT INTO tickets (guild_id, channel_id, number, user_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, channelId, number, userId, reason, nowSec);
}

function ticketByChannel(guildId, channelId) {
  const r = db.prepare('SELECT * FROM tickets WHERE guild_id=? AND channel_id=?').get(guildId, channelId);
  return r ? ticketRow(r) : null;
}

function openTicketCount(guildId, userId) {
  const r = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE guild_id=? AND user_id=? AND status='open'").get(guildId, userId);
  return Number(r.n);
}

function ticketByInitMessage(guildId, messageId) {
  const r = db.prepare('SELECT channel_id FROM tickets WHERE guild_id=? AND init_message_id=?').get(guildId, messageId);
  return r ? r.channel_id : null;
}

function updateTicket(guildId, channelId, fields) {
  const allowed = ['claimed_by', 'status', 'close_reason', 'closed_at', 'init_message_id', 'transcript_text'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return;
  vals.push(guildId, channelId);
  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE guild_id=? AND channel_id=?`).run(...vals);
}

/** Closed tickets have no channel left, so the button looks them up by number. */
function ticketByNumber(guildId, number) {
  const r = db.prepare('SELECT * FROM tickets WHERE guild_id=? AND number=?').get(guildId, number);
  return r ? ticketRow(r) : null;
}

function openTickets(guildId) {
  return db.prepare("SELECT * FROM tickets WHERE guild_id=? AND status='open'").all(guildId).map(ticketRow);
}

function ticketRow(r) {
  return {
    guildId: r.guild_id,
    channelId: r.channel_id,
    number: Number(r.number),
    userId: r.user_id,
    reason: r.reason,
    claimedBy: r.claimed_by || '',
    status: r.status,
    closeReason: r.close_reason || '',
    initMessageId: r.init_message_id || '',
    createdAt: Number(r.created_at),
    closedAt: Number(r.closed_at || 0),
    transcriptText: r.transcript_text || '',
  };
}

module.exports = {
  init,
  getXp, applyXpGain, leaderboard, leaderboardRank, totalTracked, resetXp,
  addStrike, strikeCount, strikesFor, clearStrikes,
  nextTicketNumber, createTicketRow, ticketByChannel,
  ticketByNumber, ticketByInitMessage,
  openTicketCount, updateTicket, openTickets,
};