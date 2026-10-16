# KBX Community Bot

Tickets, reaction roles, levels, auto-moderation and welcome messages for the
Minecraft modding server — **configured entirely from a website that lives in
this repo** (GitHub Pages). Change settings on the site, and the server picks
them up within ~20 seconds. No dashboard server to host: the website is
static, it just commits `config.json` to this repo via the GitHub API.

Modelled on the big ones: ticket flow after Carl-bot / Tickets bot, levelling
after Arcane, auto-mod filters after Carl-bot.

## Pieces

| piece | what it does |
|---|---|
| `index.js` + `src/` | the Discord bot (discord.js v14, Node ≥ 22, built-in SQLite) |
| `docs/` | the dashboard website — GitHub Pages serves this folder |
| `src/schema.js` | single source of truth for every setting: the bot validates with it, the site renders forms from it (`tools/sync-schema.js` keeps the copy identical) |
| `config.example.json` | the default configuration, generated from the schema |
| `tests/` | node:test suite for everything that is testable without Discord |

## Features

**Tickets** — the bot posts a panel with an *Open a ticket* button; the user
picks a **reason from the list you defined on the site**; a private
`ticket-0001` channel appears under a `Tickets` category with all the right
permission overwrites. Staff (`claimRoleIds`) get **Claim**; opener or staff
**Close** — closing always opens a modal asking *why* (optional) — then the
bot posts an HTML transcript to the log channel, DMs the opener, and either
archives the channel to a `Tickets — closed` category (with **Reopen** /
**Delete** buttons) or deletes it. Limits per user, optional auto-close after
hours of silence, per-reason role pings.

**Reaction roles** — panels: channel + emoji→role pairs. The bot posts its own
message, or reacts to a message you already posted (paste its ID). Reacting
grants, un-reacting removes (toggleable). Role-hierarchy errors surface in the
log channel instead of vanishing.

**Levels** — random XP per message (min–max) with a per-user cooldown, a curve
(first level = `xpBase`, each next × `xpGrowth`), a max level, no-XP
channels/roles, custom level-up message with `{user} {username} {level}
{server}` placeholders (channel announce or same-channel), DM option, and
**role rewards** at levels (stack, or replace-only-highest). `/rank`,
`/leaderboard`, `/givexp`, `/resetxp`.

**Auto-moderation** — banned words (catches leet/spacing variants, e.g.
`n0ce`, `g r a p e`), Discord invites (allowlist by invite code), any links
(domain allowlist with subdomains), excessive CAPS, emoji spam, mention spam,
and fast-message spam. Per-rule action: none / delete / delete+warn /
delete+timeout. Every catch = one **strike**; the ladder escalates on its own
(timeout after N, kick after M, ban after B — your numbers). Mods and listed
roles/channels are exempt; every catch is logged.

**Warns** — `/warn`, `/warnings`, `/clearwarnings` feed the same ladder the
auto-mod uses.

**Welcome & goodbye** — greeting in a channel and/or DM, farewell message,
auto-role on join. `{user} {username} {server} {memberCount}`.

Core: `/ping` `/help` `/botinfo` `/configreload` (force an instant config
refetch).

## Setup

### 1. Discord bot
1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy. Put it in `.env` (see `.env.example`).
3. Same tab: enable **Server Members Intent** and **Message Content Intent** —
   the bot refuses to start without them and tells you so.
4. Invite it: `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=1099646233686`
   (that number = view/send/embed/attach/history + reactions + manage messages/
   channels/roles + kick/ban/timeout).

### 2. The repo + website
1. Push this folder to `YOURNAME/community-bot` (public — Pages needs that on
   the free plan).
2. Repo **Settings → Pages** → Source: *Deploy from a branch* → branch `main`,
   folder `/docs`. Your dashboard is `https://YOURNAME.github.io/community-bot/`.
3. Everything the dashboard changes is a commit to `config.json`. Role IDs,
   channel IDs, word lists — nothing secret. **Never put the bot token in the
   repo.**

### 3. Dashboard permission (once)
In the dashboard, fill owner/repo/branch and paste a **fine-grained personal
access token** with **Contents: Read and write** on this repo only
(the token field links to a pre-filled creation page). It is stored in your
browser only, and it is what lets the site commit. Bot-side, a token in
`.env` (`GITHUB_TOKEN`) is optional — it only enables writing
`state.json`, which turns the dashboard's ID paste boxes into real name
dropdowns of your server's channels and roles.

### 4. Run it
```bash
cp .env.example .env      # fill in DISCORD_TOKEN (+ GITHUB_REPO)
npm install
./run.sh                  # detached; ./run.sh status | stop
```
The bot logs `watching github.com/…` then `online as …`. Fill the dashboard,
save, watch `npm run test`'s sibling: `/configreload` or wait ≤ 20 s.

## Local development without GitHub
Drop `data/config.local.json` (same shape as `config.example.json`) and it
overrides the repo config on every poll tick — handy while testing ticket
reasons or punishments without touching the real server's settings.

## Verify
```bash
npm run check   # schema sync + syntax + example config + module graph
npm test        # 28 tests: config validation, XP curve, automod matches, transcripts
```
Runtime behaviours (panel appears, claim/close, reaction grants, ladder) need
the real guild — the tests cover the pure logic; the rest is wired so errors
land in the log channel instead of dying silently.