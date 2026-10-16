# community-bot — project conventions

**KevinBevinX's Community Bot** (`community-bot`): a Discord bot for the
Minecraft modding server, configured from a GitHub Pages dashboard that
commits `config.json` to this repo. The bot polls the repo; nothing else is
required to deploy a settings change.

## Non-obvious facts (do not rediscover these)

- **`src/schema.js` is the single source of truth** for settings. The bot
  validates with it, the dashboard renders forms from it. It is loaded by
  Node (UMD check for `module.exports`) AND by the browser
  (`window.CommunitySchema`). `docs/schema.js` is a copy — `npm run check`
  re-syncs it and FAILS when it drifted. Edit `src/schema.js` only.
- **config.json is never trusted raw.** `Schema.validate()` clamps numbers to
  field bounds, drops unknown keys, coerces mentions ("#123…"/<@&…>) and fixes
  what it can; anything it couldn't fix falls back to the DEFAULT (values are
  pre-filled), and if errors remain the bot keeps the previous config and
  logs. Broken hand-edits can't brick the bot.
- **state.json is written BY THE BOT for the dashboard** (channels/roles
  snapshot → name dropdowns on the site). It needs `GITHUB_TOKEN` in `.env`
  (fine-grained, this repo, Contents: write). Without it the site degrades to
  paste-boxes; that's still functional.
- Reaction-role events on OLD messages only fire because `index.js` opts into
  `Partials.Message/Channel/Reaction`; handlers `fetch()` partials first
  (discordjs.guide partials page). Don't remove the partials.
- **`docs/` is the Pages root** (Settings → Pages → main, /docs). Files there
  are PUBLIC: config.json / state.json are readable by anyone — that's why no
  secret may ever live in them. `config.local.json` lives in `data/` and is
  gitignored.
- XP model: current-level progress stored (`xp` = XP *into the current
  level*); career XP = Σ costs + that. Cost from level L→L+1 =
  `round(xpBase * xpGrowth^L)` (schema.js exports the same math for the live
  preview on the site).
- Auto-mod catches add strikes to a table shared with `/warn`
  (source `command`); the escalation ladder fires the highest new tier per
  message and resets via `/clearwarnings`.
- Everything that can be tested without Discord is under `tests/` (node:test,
  Node 24 built-in runner). `npm run check` = schema sync + file syntax +
  regenerating `config.example.json` + module-graph load (starts no gateway).
- Node 24 has built-in `node:sqlite` (DatabaseSync) — no native deps. The DB
  is `data/bot.db`, WAL mode.
- `run.sh start|status|stop` keeps it alive with setsid; log at
  /tmp/community-bot.log.

## Gotchas hit once already

- `context.js` guards against circular imports — features read the live
  config from `require('../context').currentConfig()`, never from `index.js`.
- The dashboard's `decodeURIComponent(escape(atob(...)))` trick was replaced
  by a `TextDecoder` pipeline; keep it that way (`escape` is deprecated).
- Guild emoji names are minimum 2 characters: parseEmoji enforces that the
  way Discord does.

## Workflow

- After ANY change: `npm run check && npm test` (both must pass).
- The dashboard can be smoke-tested locally with any static server pointed at
  `docs/` — it talks to api.github.com from the browser (CORS is allowed).
- Never commit `.env`, `data/`, or any token. The dashboard token lives in
  the owner's browser localStorage only.