/**
 * Configuration loading + hot reload.
 *
 * Priority:
 *   1. config.local.json — a local file for testing without touching GitHub.
 *   2. GitHub: GITHUB_REPO (owner/name) + GITHUB_BRANCH, file GITHUB_FILE
 *      (default config.json). Polled every POLL_SECONDS (env, default 20).
 *
 * Broken configs are never applied: validate() fixes/coerces what it can and
 * reports errors; if errors survive we keep the last-good config and log.
 * `/configreload` forces an immediate refetch.
 */
const fs = require('fs');
const path = require('path');
const Schema = require('./schema');
const crypto = require('crypto');
const runtime = require('./runtime');
const { log } = require('./util');

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const REPO = process.env.GITHUB_REPO || '';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE = process.env.GITHUB_FILE || 'config.json';
const STATE_FILE = process.env.GITHUB_STATE_FILE || 'state.json';
const POLL_SECONDS = Math.max(5, parseInt(process.env.POLL_SECONDS || '20', 10));
const DATA_DIR = path.join(process.cwd(), 'data');

let current = Schema.defaults();
let currentSha = null;
let stateSha = null;
let onChange = null;
let timer = null;
let lastAppliedJson = '';
let lastStateJson = '';
let ghApiOk = true;
let lastPollErrorLog = 0;

function apiHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kevinbevinx-community-bot',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

function ghUrl(file) {
  return `https://api.github.com/repos/${REPO}/contents/${file}?ref=${encodeURIComponent(BRANCH)}`;
}

const FETCH_TIMEOUT_MS = 15000;

async function ghGet(file) {
  const res = await fetch(ghUrl(file), { headers: apiHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} for ${file}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.type !== 'file') throw new Error(`${file} is not a file in ${REPO}`);
  const text = Buffer.from(json.content || '', 'base64').toString('utf8');
  return { sha: json.sha, text };
}

async function ghPut(file, text, message) {
  const headers = apiHeaders();
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set; cannot write state.json');
  let sha;
  try {
    const existing = await ghGet(file);
    sha = existing ? existing.sha : undefined;
  } catch {
    sha = undefined;
  }
  const res = await fetch(ghUrl(file).replace(/\?ref=.*$/, ''), {
    method: 'PUT',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
      branch: BRANCH,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub PUT failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.content ? json.content.sha : null;
}

function applyConfig(text, source) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    log('config', `${source}: JSON parse failed — ${e.message}. Keeping previous config.`);
    return false;
  }
  const { ok, config, errors } = Schema.validate(raw);
  if (errors.length) {
    log('config', `${source}: ${errors.length} problem(s) (using defaults for those bits):`);
    for (const err of errors.slice(0, 10)) log('config', `  - ${err}`);
  }
  if (!ok) {
    log('config', `${source}: schema errors — keeping previous config until fixed.`);
    return false;
  }
  const asJson = JSON.stringify(config);
  if (asJson === lastAppliedJson && currentSha !== null) return true; // unchanged
  const first = lastAppliedJson === '';
  lastAppliedJson = asJson;
  current = config;
  if (onChange) {
    try {
      onChange(config, { first, source });
    } catch (e) {
      log('config', `config listener failed: ${e}`);
    }
  }
  return true;
}

async function pollOnce() {
  // Config
  try {
    const file = await ghGet(FILE);
    if (file) {
      currentSha = file.sha;
      applyConfig(file.text, `GitHub ${REPO}/${FILE}`);
      ghApiOk = true;
    } else if (currentSha === null && lastAppliedJson === '') {
      log('config', `${REPO}/${FILE} does not exist yet — using defaults. Create it from the dashboard.`);
    }
  } catch (e) {
    const now = Date.now();
    if (ghApiOk || now - lastPollErrorLog > 5 * 60 * 1000) log('config', `poll failed: ${e.message}`);
    lastPollErrorLog = now;
    ghApiOk = false;
  }

  // state.json (written by us for the dashboard's channel/role pickers)
  const collector = stateCollector;
  if (collector && process.env.GITHUB_TOKEN) {
    try {
      const state = await collector();
      if (!state) {
        log('config', 'state.json: no guild reachable yet — skipping snapshot');
        return;
      }
      const text = JSON.stringify(state, null, 2);
      // hash WITHOUT updatedAt — otherwise every second ticks the hash and we
      // commit forever (which cancelled every Pages build and froze the site)
      const { updatedAt, ...content } = state;
      const lastLocal = runtime.get('stateJsonHash', '');
      if (hash(JSON.stringify(content)) === lastLocal) {
        lastStateJson = text;
        return;
      }
      if (text !== lastStateJson) {
        stateSha = await ghPut(STATE_FILE, text, 'bot: update server snapshot (state.json)');
        lastStateJson = text;
        runtime.set('stateJsonHash', hash(JSON.stringify(content)));
        log('config', `state.json updated (${state.channels.length} channels, ${state.roles.length} roles)`);
      }
    } catch (e) {
      log('config', `state.json update failed: ${e.message}`);
    }
  }
}

let stateCollector = null;

/** Loaded config (never assume non-null during handlers; defaults are valid). */
function get() {
  return current;
}

/** Registers the callback fired whenever a new validated config arrives. */
function onConfigApplied(fn) {
  onChange = fn;
}

/** Lets the sync loop collect a state.json snapshot (channels/roles cache). */
function pushStateCollector(fn) {
  stateCollector = fn;
}

function start() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const localPath = path.join(DATA_DIR, 'config.local.json');
  if (fs.existsSync(localPath)) {
    const text = fs.readFileSync(localPath, 'utf8');
    log('config', `using local override ${DATA_DIR}/config.local.json (GitHub polling is still on, but local wins each tick)`);
    applyConfig(text, 'config.local.json');
    // Local override wins: reapply after every poll attempt.
    const remoteApply = applyConfig;
    // simplest: re-read local after each pollOnce
    const orig = pollOnce;
    pollOnce = async () => {
      await orig();
      applyConfig(fs.readFileSync(localPath, 'utf8'), 'config.local.json');
    };
  } else if (!REPO) {
    log('config', 'GITHUB_REPO is not set and no data/config.local.json found — running on schema defaults only. Configure the dashboard or create data/config.local.json.');
  }

  if (REPO) {
    log('config', `watching github.com/${REPO} (${BRANCH}) → ${FILE} every ${POLL_SECONDS}s`);
    void pollOnce();
    timer = setInterval(() => void pollOnce(), POLL_SECONDS * 1000);
    timer.unref();
  }
}

function stop() {
  if (timer) clearInterval(timer);
}

module.exports = {
  get,
  onConfigApplied,
  pushStateCollector,
  start,
  stop,
  reload: async () => pollOnce(), // thunk so the local-override wrapper is honoured
  __writeStateFile: ghPut,
  __readTest: applyConfig,
};