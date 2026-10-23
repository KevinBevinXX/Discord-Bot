# Deploying KBX Community Bot

Instructions for an operator (human or agent) setting this up on a server with
no prior knowledge of the project. Every step has a check — if a check fails,
stop there rather than continuing.

## What you are deploying

A Discord bot for one guild. It is a **single long-running Node process with
no inbound network surface**: no HTTP server, no ports to open, outbound HTTPS
only (Discord gateway + REST, and api.github.com).

Its settings do **not** live on your server. The owner edits them on a GitHub
Pages dashboard that commits `config.json` to this repo; the bot polls that
file every 20 seconds and applies changes live. So:

- deploying a settings change = nothing, it happens by itself
- deploying a code change = pull + restart
- `data/` on your disk is the only state that is yours (SQLite + runtime ids)

```
owner's browser ──commits config.json──► GitHub repo ◄──polls every 20s── bot (your server)
                                              ▲                              │
                                              └──writes state.json───────────┘
                                                 (needs GITHUB_TOKEN)
```

## 1. Prerequisites

| Need | Why | Check |
|---|---|---|
| **Node.js 24+** | uses built-in `node:sqlite` and the built-in test runner; older Node will fail at require time | `node -v` |
| git | clone + pull | `git --version` |
| ~200 MB RAM, any CPU | single process, idle most of the time | — |
| Outbound HTTPS (443) | discord.com, gateway.discord.gg, api.github.com | `curl -sI https://discord.com/api/v10/gateway` |

There are **no native dependencies** — only `discord.js` and `dotenv`. If a
build step wants a compiler, something is wrong.

## 2. Secrets you must obtain from the owner

| Variable | What it is | Notes |
|---|---|---|
| `DISCORD_TOKEN` | the bot's token | Developer Portal → app → Bot → Reset Token. **Resetting it invalidates the copy the current host is using.** |
| `GITHUB_REPO` | `owner/name` of this repo | same repo the dashboard writes to |
| `GITHUB_TOKEN` | *optional but recommended* | fine-grained PAT, **this repo only, Contents: read and write**. Without it the bot cannot publish `state.json`, and the owner's dashboard loses its channel/role dropdowns (it degrades to pasting raw IDs). |

Never commit `.env`. It is gitignored; keep it that way.

## 3. Two privileged intents must be ON

In the Discord Developer Portal → your app → Bot → Privileged Gateway Intents,
enable both:

- **Server Members Intent** — welcome messages and autorole
- **Message Content Intent** — auto-mod and XP cannot see message text without it

If these are off the bot still logs in and looks healthy, then silently does
nothing on messages or joins. This is the most common bad deploy.

## 4. Build

```bash
git clone https://github.com/KevinBevinXX/Discord-Bot.git
cd Discord-Bot
npm install
cp .env.example .env     # then fill DISCORD_TOKEN, GITHUB_REPO, GITHUB_TOKEN
```

**Check:** `npm run check && npm test`

Both run fully offline — no Discord connection, no token needed. `check`
verifies the schema copy used by the dashboard is in sync, syntax-checks every
file, regenerates `config.example.json`, and loads the module graph. `test`
runs the unit suite (60+ tests). **If either fails, do not deploy** — the
repo is expected to be green at all times.

There is a third suite, `npm run vtest`, which drives the real dashboard in
headless Chrome against a mock GitHub. It needs `google-chrome` on PATH. It
is a pre-push gate for code changes, not a deploy gate — skip it on a headless
server unless Chrome is present.

## 5. Coordinate the cutover — this bites

**One instance per Discord token.** If two copies run with the same token,
Discord logs the older session out and both behave erratically (commands
answered twice or not at all, duplicate ticket channels).

Before you start yours, confirm the current host has stopped:

```bash
./run.sh stop      # on the OLD host
./run.sh status    # must print "not running"
```

Only then start yours.

## 6. Run it

Either way works; use systemd on a real server.

**Simple:** `./run.sh` — starts detached with `setsid`, pid in `data/bot.pid`,
log at `/tmp/community-bot.log`. `./run.sh status` and `./run.sh stop` do what
they say. Note the log lives in `/tmp` and disappears on reboot.

**systemd (recommended):** `/etc/systemd/system/kbx-bot.service`

```ini
[Unit]
Description=KBX Community Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kbxbot
WorkingDirectory=/opt/Discord-Bot
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/kbx-bot.log
StandardError=append:/var/log/kbx-bot.log
# the process writes only to data/ inside WorkingDirectory
ProtectSystem=full
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now kbx-bot
```

Run it as an unprivileged user that owns the checkout. It needs write access
to `data/` and nothing else.

## 7. Validate the deploy

### 7a. The log must show all four lines within ~15 seconds

```
[db] ready at .../data/bot.db
[config] watching github.com/<owner>/<repo> (main) → config.json every 20s
[boot] KBX Community Bot online as <name>#1234 — 1 guild(s)
[commands] 11 commands registered to <guild name>
```

`1 guild(s)` is important: `0` means the bot is not in the server, and
nothing will work.

### 7b. Config polling is alive

Watch for this after the owner saves anything on the dashboard (within ~20s):

```
[config] → features re-applied (source: GitHub <owner>/<repo>/config.json)
```

If you instead see `[config] poll failed: GitHub 404` the repo or branch in
`.env` is wrong. `GitHub 401/403` means the token is bad — but note the bot
polls **public** repos without a token, so a 401 points at `GITHUB_TOKEN`
being set to something invalid rather than missing.

### 7c. It is actually in Discord

With `DISCORD_TOKEN` in the environment:

```bash
curl -s -H "Authorization: Bot $DISCORD_TOKEN" \
  https://discord.com/api/v10/users/@me | head -c 200
```

Expect a JSON user object. `401 Unauthorized` means the token is wrong or was
reset out from under you.

### 7d. End-to-end behaviour check

Ask the owner to do each, and watch the log:

| Action | Expected |
|---|---|
| Save anything on the dashboard | `features re-applied` within 20s |
| Click the ticket panel button → pick a reason | a `ticket-00NN` channel appears; `[tickets]` lines in the log |
| Close the ticket | transcript embed posts in the log channel; channel deletes after 10s |
| React on a reaction-role panel | member gains the role; `[reactionroles] <user> → <roleId>` |
| Send a normal message | XP accrues silently (needs Message Content intent) |

If a role grant fails, the usual causes are **the bot's role sitting below the
role it is trying to assign**, or Manage Roles missing. The log says which.

## 8. State and migration

`data/` is per-host and gitignored:

- `bot.db` — SQLite: XP/levels, strikes, ticket records. **This is the only
  irreplaceable thing.** A fresh host starts with zero XP and ticket numbering
  from #1.
- `runtime.json` — ids of messages the bot posted (ticket panel, reaction
  panels). Starting without it is safe: the bot re-posts the ticket panel on
  the next dashboard save and re-posts reaction panels on boot.

To preserve member XP and ticket history, stop the old bot, copy `data/bot.db`
(and `bot.db-wal` / `bot.db-shm` if present) to the new host's `data/`, then
start. Copying a live database risks a torn file — stop first.

## 9. State of the config at handover

Two things are deliberately switched off. Do not "fix" them without asking:

- **Auto-mod banned-word filter is disabled** (`automod.bannedWords.enabled:
  false`). The word list is populated (154 entries) but nothing is being
  deleted. Turning on auto-deletion in a live community is the owner's call.
- **Warning roles are unconfigured** (`automod.strikeRoles` is absent, which
  validates to an empty list). The feature works; the owner picks which role
  at how many strikes.

Live and working: the ticket system, one reaction-role panel, levels/XP,
welcome messages.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Starts, then exits immediately | bad `DISCORD_TOKEN` | check the log's first error line |
| `0 guild(s)` | bot not invited to the server | owner re-invites with the OAuth URL |
| Commands do nothing | duplicate instance stealing the session | confirm only one process per token |
| XP never accrues, auto-mod never fires | Message Content intent off | enable it in the Developer Portal, restart |
| Welcome messages never fire | Server Members intent off | same |
| Dashboard dropdowns show raw ID boxes | `GITHUB_TOKEN` missing/unscoped, so `state.json` is stale | fine-grained PAT, Contents: write |
| `Connect Timeout Error` in the log | transient network blip | the bot retries reactions and role grants three times; persistent timeouts mean egress is being blocked |
| Ticket panel vanished and never came back | by design — a deleted panel stays deleted | owner saves once on the dashboard and it re-posts |

## 11. Changing code

`.git/hooks/pre-push` runs check + unit tests + the headless-browser suite and
rejects the push if anything fails, so a push needs Chrome available. Project
conventions — including things that look like bugs but are deliberate — are in
`CLAUDE.md` (symlinked as `AGENTS.md`). Read it before changing anything; it
documents several traps that have already cost a debugging round each.

The dashboard is GitHub Pages served from `docs/` on `main`. If you change
anything in `docs/`, bump the `?v=NN` query on all four asset references in
`docs/index.html` — browsers cache that page and the version bump is what
forces them to reload.
