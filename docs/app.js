/* Dashboard for KBX Community Bot.
 * Talks straight to the GitHub Contents API from the browser; the bot polls
 * config.json and applies it live. Credentials live in localStorage only.
 * Schema (window.CommunitySchema) is the same file the bot validates with. */
/* global CommunitySchema */
'use strict';

const S = CommunitySchema;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LS_CREDS = 'kcb:creds';

/* Self-heal against CDN/browser caching: if a fresher index.html references a
 * newer asset version than the one running, reload ONCE to pick it up. */
(function () {
  try {
    const mine = parseInt(((document.currentScript && document.currentScript.src) || '').match(/v=(\d+)/) ? RegExp.$1 : '0', 10);
    fetch(location.pathname + '?nocache=' + Date.now(), { cache: 'no-store' })
      .then((r) => r.text())
      .then((html) => {
        const versions = [...html.matchAll(/[?&]v=(\d+)/g)].map((m) => parseInt(m[1], 10));
        const latest = versions.length ? Math.max(...versions) : mine;
        const seen = sessionStorage.getItem('kcb:healed:' + latest);
        if (latest > mine && !seen) {
          sessionStorage.setItem('kcb:healed:' + latest, '1');
          // NOT location.reload(): that is an ordinary refresh and may be
          // served straight from the HTTP cache (MDN: the forceGet bypass is
          // Firefox-only), so a stale index.html re-served itself and the page
          // healed into doing nothing. A URL the cache has never seen cannot
          // come back stale.
          location.replace(location.pathname + '?v=' + latest + (location.hash || ''));
        }
      })
      .catch(() => {});
  } catch { /* never block the page over this */ }
})();

const state = {
  owner: '', repo: '', branch: 'main', token: '',
  config: null,   // parsed config.json (validated view)
  sha: null,      // current blob sha for PUT
  serverState: null, // state.json (channels/roles for pickers)
};

/* -------------------------------- blob api -------------------------------- */

function apiRoot() {
  // test override only: the virtual tester points this at a local mock
  const base = localStorage.getItem('kcb:apiBase') || 'https://api.github.com';
  return `${base}/repos/${state.owner}/${state.repo}`;
}
function headers(base) {
  const h = { Accept: 'application/vnd.github+json', ...(base || {}) };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return h;
}

async function getFile(path) {
  // cache:'no-store' + a cache-buster: the browser's HTTP cache was handing
  // back shas from BEFORE a previous save → 409 on the next PUT
  const bust = `&t=${Date.now()}`;
  const res = await fetch(`${apiRoot()}/contents/${path}?ref=${encodeURIComponent(state.branch)}${bust}`, { headers: headers(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} — ${res.status === 403 ? 'check your token (needs Contents: read/write on this repo)' : 'error'}`);
  const j = await res.json();
  return { sha: j.sha, text: j.content ? new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\s/g, '')), (c) => c.charCodeAt(0))) : '' };
}

async function putFile(path, text, message, sha) {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const res = await fetch(`${apiRoot()}/contents/${path}`, {
    method: 'PUT',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, content: b64, branch: state.branch, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`commit failed (GitHub ${res.status}): ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  return j.content && j.content.sha;
}

/* ------------------------- discord preview helpers ------------------------ */

function mdLite(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`);
}

const SAMPLES = {
  user: '@Kevin', username: 'Kevin', level: '7', server: 'Modded Server', memberCount: '42',
  reason: 'Modpack / mod issue', channel: '#support',
};
const SAMPLE_LINES = ['Zero 👋', 'Rex⁶⁴', 'DiamondDave'];
const SAMPLE_LINES_LOW = ['modder_jane', 'fartman92', 'xX_mlk_Xx'];

function fillSamples(text, extra) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (extra && extra[k] !== undefined ? extra[k] : SAMPLES[k] !== undefined ? SAMPLES[k] : m));
}

/** Renders a Discord-look embed. opts: {color, title, description, fields, footer} */
function discordLook(opts) {
  const color = /^#[0-9a-fA-F]{6}$/.test(opts.color || '') ? opts.color : '#5865F2';
  return `<div class="dc-msg">
    <div class="dc-avatar">🤖</div>
    <div class="dc-body">
      <div class="dc-name">KBX Community Bot</div>
      <div class="dc-embed" style="--ec:${color}">
        ${opts.title ? `<div class="dc-title">${mdLite(fillSamples(opts.title))}</div>` : ''}
        ${opts.description ? `<div class="dc-desc">${mdLite(fillSamples(opts.description))}</div>` : ''}
        ${(opts.fields || []).map((f) => `<div class="dc-field"><div class="fname">${esc(f.name)}</div><div class="fval">${mdLite(fillSamples(f.value))}</div></div>`).join('')}
        <div class="dc-footer">🤖 KBX Community Bot${opts.footer ? ` · ${esc(opts.footer)}` : ''} · just now</div>
      </div>
    </div>
  </div>`;
}

function previewBlock(id) {
  return `<div class="preview"><div class="section-title">How it looks in Discord</div><div id="${id}"></div></div>`;
}

/* --------------------------------- set up --------------------------------- */

function loadCreds() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CREDS) || 'null');
    if (c) {
      $('inOwner').value = state.owner = c.owner || '';
      $('inRepo').value = state.repo = c.repo || '';
      $('inBranch').value = state.branch = c.branch || 'main';
      if (c.token) $('inToken').placeholder = '••••• stored — leave blank to reuse';
      state.token = c.token || '';
    }
  } catch { /* fresh */ }
}

function saveCreds() {
  const old = JSON.parse(localStorage.getItem(LS_CREDS) || '{}');
  localStorage.setItem(LS_CREDS, JSON.stringify({
    owner: state.owner, repo: state.repo, branch: state.branch,
    token: $('inToken').value ? $('inToken').value : old.token || '',
  }));
}

function setConn(kind, text) {
  const tokenNote = state.token ? ' · ✏️ token stored (can save)' : ' · 🔒 read-only (no token — saves will fail)';
  $('connStatus').innerHTML = `<span class="dot ${kind}"></span>${esc(text)}${tokenNote}`;
}

async function connect() {
  state.owner = $('inOwner').value.trim().replace(/\/.*$/, '');
  state.repo = $('inRepo').value.trim();
  state.branch = $('inBranch').value.trim() || 'main';
  state.token = $('inToken').value.trim() || state.token;
  if (!state.owner || !state.repo) {
    setupMsg('Fill in the owner and repo name first.', false);
    return;
  }
  saveCreds();
  setConn('warn', 'loading…');
  try {
    const [cfg, serverState] = await Promise.all([getFile('config.json'), getFile('state.json')]);
    if (cfg) {
      const validated = S.validate(JSON.parse(cfg.text));
      state.config = validated.config;
      state.sha = cfg.sha;
      if (validated.errors.length) setupMsg(`Loaded — but ${validated.errors.length} value(s) fell back to defaults (see each card).`, false);
      else setupMsg('Connected.', true);
    } else {
      state.config = S.defaults();
      state.sha = null;
      setupMsg('No config.json yet — the card views below can create it on first save.', false);
    }
    state.serverState = serverState ? JSON.parse(serverState.text) : null;
    renderCards();
    let extra = '';
    if (state.serverState && state.serverState.updatedAt) {
      const mins = Math.round((Date.now() - new Date(state.serverState.updatedAt).getTime()) / 60000);
      if (Number.isFinite(mins) && mins >= 0) extra = ` · server snapshot ${mins >= 60 ? Math.round(mins / 60) + 'h' : mins + 'm'} old`;
    }
    setConn('ok', `${state.owner}/${state.repo}@${state.branch}${extra}`);
  } catch (e) {
    setConn('err', 'connection failed');
    setupMsg(e.message, false);
  }
}

function setupMsg(text, ok) {
  const el = $('setupMsg');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

/* -------------------------------- rendering ------------------------------- */

let editing = null; // feature key currently open

function featValues(key) {
  return (state.config || S.defaults())[key];
}

function featureSummary(f) {
  const v = featValues(f.key);
  const enabled = v.enabled !== false;
  switch (f.key) {
    case 'general': return `${v.adminRoleIds.length} admin role(s)`;
    case 'tickets': return `${(v.reasons || []).length} reasons · ${(v.claimRoleIds || []).length} staff role(s)`;
    case 'reactionRoles': return `${v.panels.length} panel(s)`;
    case 'levels': return `XP ${v.xpMin}–${v.xpMax} per message · max level ${v.maxLevel} · ${v.roleRewards.length} reward(s)`;
    case 'automod': return `${Object.entries(v).filter(([k, x]) => x && typeof x === 'object' && x.enabled).length} filter(s) on`;
    case 'welcome': return v.welcomeChannelId ? 'greeting set' : 'not configured yet';
    default: return '';
  }
}

function renderCards() {
  const cards = S.FEATURES.map((f) => {
    const v = featValues(f.key);
    const on = f.key === 'general' ? true : v.enabled !== false;
    return `<div class="card feat" data-feat="${f.key}">
      <div class="card-head"><span class="icon">${f.icon}</span>
        <div><h3>${esc(f.name)}</h3><p class="muted">${esc(f.blurb)}</p><div class="count">${esc(featureSummary(f))}</div></div>
      </div>
      <span class="state ${on ? 'on' : ''}">${on ? 'ON' : 'OFF'}</span>
    </div>`;
  }).join('');
  const setupHtml = `
  <div class="card">
    <div class="card-head"><span class="icon">🧰</span><div><h3>First-time setup (once)</h3>
      <ol class="steps">
        <li><b>Bot token:</b> create a Discord application at <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers</a> → Bot → Reset Token. Put it in the bot's <code>.env</code> on the server. Also enable <b>Server Members</b> and <b>Message Content</b> intents there.</li>
        <li><b>Repo + Pages:</b> push this project to <code>${esc(state.owner || 'owner')}/${esc(state.repo || 'repo')}</code>, then repo <b>Settings → Pages</b> → Source: <i>Deploy from a branch</i>, branch <code>${esc(state.branch)}</code>, folder <code>/docs</code>. Open the URL shown there — this page, live.</li>
        <li><b>Config permission:</b> create a fine-grained token (link in the token field) limited to <i>this repo</i> with <b>Contents: Read and write</b>, and paste it above. That is what lets the website commit your settings.</li>
        <li><b>Invite the bot:</b> README has the invite link + the exact permissions.</li>
      </ol>
    </div></div>
  </div>`;
  $('cards').innerHTML = `<div class="cards-grid">${cards}</div>` + setupHtml;
  document.querySelectorAll('.feat').forEach((el) => el.addEventListener('click', () => openEditor(el.dataset.feat)));
}

/* ------------------------------ emoji picker ------------------------------ */

const EMOJI_GROUPS = [
  ['Popular', '🎮 🎲 🧩 🛠️ ⚙️ 🚩 ❓ ✅ ❌ ⚠️ 🔥 ⭐ 💤 💥 🏆 🎉 👑 💎 🧱 ⛏️ 🗡️ 🛡️ 🧪 🍎 ❤️ 💀 👻 🤖 🐺 🐉 🌟'],
  ['Faces', '😀 😆 😎 🤔 😴 😇 🥳 😡 🤖 👻 👀 🙃 😭 😤 🤯 🥶 😱 🤠'],
  ['Objects', '💻 📱 🎧 🎤 📷 📦 📌 🔑 🔒 💡 🔔 📢 🧭 ⏰ 🔫 🏹 🪓 🔮 🧿 🎁'],
  ['Nature', '🌿 🌳 🍄 ⚡ 🌙 ☀️ 🌊 ❄️ 🌋 🪨 🌵 🍀 🌹 🌻 🦴 🕷️ 🐛 🦇'],
  ['People', '👤 👥 🧍 🙋 🛡️soldier 👮 🕵️ 🧙 🦸 🥷 👮‍♂️'],
  ['Symbols', '💯 ❗ ⁉️ ♻️ ➕ ➖ 🆗 🔰 ⚜️ ☮️ 🔱 ⚡ ☢️ 🚫 🔴 🟢 🟡 🔵'],
];

let emojiPop = null;

function openEmojiPicker(anchor, input, onChange) {
  if (emojiPop) { emojiPop.remove(); emojiPop = null; }
  emojiPop = document.createElement('div');
  emojiPop.className = 'emoji-pop';
  emojiPop.innerHTML = EMOJI_GROUPS.map(([name, list]) =>
    `<div class="emo-cat">${esc(name)}</div><div class="emo-grid">${list.split(/\s+/).filter((e) => !/[a-z]/i.test(e)).map((e) => `<button type="button" class="emo" data-e="${e}">${e}</button>`).join('')}</div>`,
  ).join('') + '<div class="emo-x">✕ close</div>';
  document.body.appendChild(emojiPop);
  const r = anchor.getBoundingClientRect();
  const pw = 300, ph = Math.min(340, window.innerHeight - 60);
  emojiPop.style.left = Math.min(r.left, window.innerWidth - pw - 10) + 'px';
  emojiPop.style.top = Math.min(r.bottom + 6, window.innerHeight - ph - 10) + 'px';
  emojiPop.querySelectorAll('.emo').forEach((b) => b.addEventListener('click', () => {
    input.value = b.dataset.e;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeEmojiPicker();
    input.focus();
  }));
  emojiPop.querySelector('.emo-x').addEventListener('click', closeEmojiPicker);
  setTimeout(() => document.addEventListener('mousedown', emojiOutside), 0);
}

function emojiOutside(e) {
  if (emojiPop && !emojiPop.contains(e.target) && !e.target.classList.contains('emoji-btn')) closeEmojiPicker();
}

function closeEmojiPicker() {
  if (emojiPop) { emojiPop.remove(); emojiPop = null; }
  document.removeEventListener('mousedown', emojiOutside);
}

/* ------------------------------ form building ----------------------------- */

function hintEl(hint) {
  return hint ? `<span class="hint">${esc(hint)}</span>` : '';
}

function channelOptions() {
  const rows = (state.serverState && state.serverState.channels) || [];
  return rows.filter((c) => c.type === 'text' || c.type === 'announcement');
}
function roleOptions() {
  const rows = (state.serverState && state.serverState.roles) || [];
  return rows.filter((r) => !r.managed);
}

function labelFor(list, id) {
  const row = list.find((x) => x.id === id);
  return row ? `#${row.name}` : id ? `id: ${String(id).slice(0, 8)}…` : '(not set)';
}

function buildField(field, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'fld';
  const labelText = `${field.label}${field.required ? ' *' : ''}`;
  switch (field.type) {
    case 'bool': {
      wrap.innerHTML = `<label class="toggle"><input type="checkbox" ${value ? 'checked' : ''}><span class="lbltext">${esc(field.label)}</span></label>${hintEl(field.hint)}`;
      wrap.querySelector('input').addEventListener('change', (e) => onChange(e.target.checked));
      return wrap;
    }
    case 'number': {
      wrap.innerHTML = `<label>${esc(labelText)}<input type="number" value="${esc(value)}" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${field.step ? `step="${field.step}"` : ''}>${hintEl(field.hint)}</label>`;
      wrap.querySelector('input').addEventListener('input', (e) => onChange(parseFloat(e.target.value)));
      return wrap;
    }
    case 'emoji': {
      wrap.innerHTML = `<label>${esc(labelText)}<span class="emocell"><input type="text" class="emoji-input" value="${esc(value || '')}" placeholder="🎮"><button type="button" class="btn small emoji-btn" title="Pick an emoji">😀</button></span>${hintEl(field.hint)}</label>`;
      const ein = wrap.querySelector('input');
      ein.addEventListener('input', (e) => onChange(e.target.value));
      wrap.querySelector('.emoji-btn').addEventListener('click', (e) => openEmojiPicker(e.currentTarget, ein, onChange));
      return wrap;
    }
    case 'text':
    case 'color': {
      wrap.innerHTML = `<label>${esc(labelText)}<input type="text" value="${esc(value || '')}" maxlen="${field.max || 200}">${hintEl(field.hint)}</label>`;
      wrap.querySelector('input').addEventListener('input', (e) => onChange(e.target.value));
      return wrap;
    }
    case 'textarea': {
      wrap.innerHTML = `<label>${esc(labelText)}<textarea>${esc(value || '')}</textarea>${hintEl(field.hint)}</label>`;
      wrap.querySelector('textarea').addEventListener('input', (e) => onChange(e.target.value));
      return wrap;
    }
    case 'channel': {
      const opts = channelOptions();
      if (opts.length) {
        wrap.innerHTML = `<label>${esc(labelText)}<select><option value="">(none)</option>${opts.map((c) => `<option value="${esc(c.id)}" ${c.id === value ? 'selected' : ''}>${esc(c.category ? c.category + ' / ' : '')}${esc(c.name)}</option>`).join('')}</select>${hintEl(field.hint)}</label>`;
        wrap.querySelector('select').addEventListener('change', (e) => onChange(e.target.value));
      } else {
        wrap.innerHTML = `<label>${esc(labelText)}<input type="text" value="${esc(value || '')}" placeholder="channel ID — connect a live bot to get dropdowns">${hintEl(field.hint)}</label>`;
        wrap.querySelector('input').addEventListener('input', (e) => onChange(e.target.value));
      }
      return wrap;
    }
    case 'channels': case 'roles': {
      const opts = field.type === 'channels' ? channelOptions() : roleOptions();
      const picked = new Set(value || []);
      if (opts.length) {
        const prefix = field.type === 'channels' ? '#' : '@';
        wrap.innerHTML = `<label>${esc(field.label)}<div class="chips">${opts.map((c) => `<span class="chip ${picked.has(c.id) ? 'on' : ''}" data-id="${esc(c.id)}">${prefix}${esc(c.name)}</span>`).join('')}</div></label>`;
        wrap.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
          const id = chip.dataset.id;
          if (picked.has(id)) picked.delete(id); else picked.add(id);
          chip.classList.toggle('on');
          onChange([...picked]);
        }));
      } else {
        wrap.innerHTML = `<label>${esc(field.label)}<input type="text" value="${esc((value || []).join(','))}" placeholder="IDs separated by commas">${hintEl(field.hint)}</label>`;
        wrap.querySelector('input').addEventListener('input', (e) => onChange(e.target.value.split(/[,\s]+/).filter(Boolean)));
      }
      return wrap;
    }
    case 'role': {
      const opts = roleOptions();
      if (opts.length) {
        wrap.innerHTML = `<label>${esc(labelText)}<select><option value="">(none)</option>${opts.map((r) => `<option value="${esc(r.id)}" ${r.id === value ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>${hintEl(field.hint)}</label>`;
        wrap.querySelector('select').addEventListener('change', (e) => onChange(e.target.value));
      } else {
        wrap.innerHTML = `<label>${esc(labelText)}<input type="text" value="${esc(value || '')}" placeholder="role ID">${hintEl(field.hint)}</label>`;
        wrap.querySelector('input').addEventListener('input', (e) => onChange(e.target.value));
      }
      return wrap;
    }
    case 'guild': {
      const st = state.serverState;
      const servers = st ? [st] : []; // snapshot is for the one server the bot is in
      wrap.innerHTML = `<label>${esc(labelText)}<input type="text" list="guildlist" value="${esc(value || '')}" placeholder="${servers.length ? 'pick your server' : 'connect to load the snapshot'}">${hintEl(field.hint)}</label><datalist id="guildlist">${servers.map((g) => `<option value="${esc(g.guildId)}">${esc(g.guildName || 'server')}</option>`).join('')}</datalist>`;
      wrap.querySelector('input').addEventListener('input', (e) => onChange(e.target.value));
      return wrap;
    }
    case 'category': {
      const cats = (state.serverState && state.serverState.channels || []).filter((c) => c.type === 'category');
      const dlId = 'catlist-' + field.key;
      wrap.innerHTML = `<label>${esc(labelText)}<input type="text" list="${dlId}" value="${esc(value || '')}" placeholder="pick or type a name">${hintEl(field.hint)}</label><datalist id="${dlId}">${cats.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>`;
      wrap.querySelector('input').addEventListener('input', (e) => onChange(e.target.value));
      return wrap;
    }
    case 'select': {
      wrap.innerHTML = `<label>${esc(labelText)}<select>${field.options.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${hintEl(field.hint)}</label>`;
      wrap.querySelector('select').addEventListener('change', (e) => onChange(e.target.value));
      return wrap;
    }
    case 'action': {
      const opts = [
        { value: 'none', label: 'Do nothing' },
        { value: 'delete', label: 'Delete the message' },
        { value: 'delete+warn', label: 'Delete + warn the user' },
        { value: 'delete+timeout', label: 'Delete + timeout the user' },
      ];
      wrap.innerHTML = `<label>${esc(labelText)}<select>${opts.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      wrap.querySelector('select').addEventListener('change', (e) => onChange(e.target.value));
      return wrap;
    }
    case 'wordlist': {
      wrap.innerHTML = `<label>${esc(labelText)}<textarea>${esc((value || []).join('\n'))}</textarea>${hintEl(field.hint)}</label>`;
      wrap.querySelector('textarea').addEventListener('input', (e) => onChange(e.target.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
      return wrap;
    }
    case 'list': {
      // a list inside a list item — reaction-role panels hold their emoji→role
      // pairs this way. Without this branch the editor printed
      // "unsupported field list" and the pairs could not be edited at all.
      const nested = buildList(field, Array.isArray(value) ? value : [], onChange);
      nested.classList.add('nested-list');
      return nested;
    }
    default:
      wrap.innerHTML = `<p class="muted">unsupported field ${esc(field.type)}</p>`;
      return wrap;
  }
}

function defaultItem(listField) {
  const item = {};
  for (const sub of listField.item) {
    item[sub.key] = sub.def !== undefined ? JSON.parse(JSON.stringify(sub.def)) : (sub.required ? (sub.type === 'number' ? 1 : '') : sub.type === 'number' ? 0 : sub.type === 'bool' ? false : sub.type === 'roles' || sub.type === 'channels' || sub.type === 'wordlist' ? [] : '');
  }
  return item;
}

function buildList(listField, items, onChange) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="section-title">${esc(listField.label)}</div>${listField.hint ? `<p class="muted">${esc(listField.hint)}</p>` : ''}`;
  const listEl = document.createElement('div');
  const render = () => {
    listEl.innerHTML = '';
    if (!items.length) listEl.innerHTML = '<p class="list-empty">Nothing here yet — add one below.</p>';
    items.forEach((item, idx) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'list-item';
      const title = `#${idx + 1}`;
      itemEl.innerHTML = `<button class="btn small danger rm">remove</button><h4>${esc(`#${idx + 1}`)} ${esc(item.name || item.label || item.emoji || '')}</h4>`;
      itemEl.querySelector('.rm').addEventListener('click', () => {
        items.splice(idx, 1);
        onChange(items);
        render();
      });
      const grid = document.createElement('div');
      grid.className = 'grid-2';
      listField.item.forEach((sub) => {
        grid.appendChild(buildField(sub, item[sub.key], (val) => {
          item[sub.key] = val;
          onChange(items);
          const h4 = itemEl.querySelector('h4');
          if (h4) h4.textContent = `${title} ${item.name || item.label || item.emoji || ''}`;
        }));
      });
      itemEl.appendChild(grid);
      listEl.appendChild(itemEl);
    });
    const add = document.createElement('div');
    add.className = 'addwrap';
    add.innerHTML = `<button class="btn small">+ add</button>`;
    add.querySelector('button').addEventListener('click', () => {
      items.push(defaultItem(listField));
      onChange(items);
      render();
      const last = listEl.querySelector('.list-item:last-of-type input');
      if (last) last.focus();
    });
    listEl.appendChild(add);
  };
  render();
  wrap.appendChild(listEl);
  return wrap;
}

/* --------------------------------- editor --------------------------------- */

let draft = null; // deep copy being edited

function openEditor(key) {
  editing = key;
  const f = S.FEATURES.find((x) => x.key === key);
  draft = JSON.parse(JSON.stringify(featValues(key)));
  $('edIcon').textContent = f.icon;
  $('edTitle').textContent = f.name;
  $('edBlurb').textContent = f.blurb;
  const body = $('edBody');
  body.innerHTML = '';
  for (const field of f.fields) {
    if (field.type === 'list') {
      body.appendChild(buildList(field, draft[field.key], () => updateDiff()));
    } else if (field.type === 'group') {
      const g = document.createElement('div');
      g.className = 'group';
      g.innerHTML = `<div class="gtitle">${esc(field.label)}</div>${field.hint ? `<p class="group-hint">${esc(field.hint)}</p>` : ''}`;
      const grid = document.createElement('div');
      grid.className = 'grid-2';
      for (const sub of field.fields) {
        grid.appendChild(buildField(sub, draft[field.key][sub.key], (val) => {
          draft[field.key][sub.key] = val;
          updateDiff();
        }));
      }
      g.appendChild(grid);
      body.appendChild(g);
    } else {
      const holder = document.createElement('div');
      body.appendChild(holder);
      holder.appendChild(buildField(field, draft[field.key], (val) => {
        draft[field.key] = val;
        updateDiff();
      }));
    }
  }
  // levels curve preview
  if (key === 'levels') {
    const prev = document.createElement('div');
    prev.innerHTML = `<div class="section-title">XP curve preview</div><p class="muted" id="curvePrev"></p>`;
    body.appendChild(prev);
  }
  if (['tickets', 'levels', 'welcome', 'reactionRoles', 'automod'].includes(key)) {
    const prev = document.createElement('div');
    prev.innerHTML = previewBlock('edPreview');
    body.appendChild(prev);
  }
  updateDiff();
  $('overlay').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeEditor() {
  $('overlay').hidden = true;
  document.body.style.overflow = '';
  editing = null;
}

function updatePreview() {
  const slot = $('edPreview');
  if (!slot || !draft) return;
  let html = '';
  if (editing === 'tickets') {
    html = discordLook({ color: draft.panelColor, title: draft.panelTitle, description: draft.panelText, footer: 'Tickets' });
  } else if (editing === 'levels') {
    html = discordLook({
      color: '#23c55e',
      title: '🎉 Level up!',
      description: draft.announceMessage,
      footer: `Levels · ${SAMPLES.server}`,
    });
  } else if (editing === 'welcome') {
    html = discordLook({
      color: '#23c55e',
      title: `👋 Welcome to ${SAMPLES.server}!`,
      description: draft.welcomeMessage,
      footer: `member #${SAMPLES.memberCount}`,
    });
  } else if (editing === 'reactionRoles') {
    const panel = (draft.panels && draft.panels[0]) || {};
    html = discordLook({
      color: '#5865F2',
      title: panel.embedTitle || 'Pick your roles',
      description: panel.messageContent || 'React below to get your roles, un-react to drop them.',
      footer: 'Reaction roles',
    });
  } else if (editing === 'automod') {
    html = discordLook({
      color: '#ed4245',
      title: '🛡️ Auto-mod caught: bannedWords',
      fields: [
        { name: 'User', value: `@${SAMPLES.username}\n\`kevin\`` },
        { name: 'Channel', value: '#general' },
        { name: 'Action', value: draft.bannedWords && draft.bannedWords.action || 'delete+warn' },
        { name: 'Message', value: 'look at this ***word***' },
      ],
      footer: 'Auto-mod',
    }) + `<p class="muted" style="margin-top:6px">Follow-up in chat: <code>@Kevin, that word is not allowed here. (removed by auto-mod)</code> — auto-deleted after 6s.</p>`;
  }
  slot.innerHTML = html;
}

function updateDiff() {
  if (editing === 'levels' && $('curvePrev')) {
    const L = draft;
    const rows = [];
    for (let i = 0; i < 6 && i < L.maxLevel; i++) rows.push(`level ${i + 1} costs ${S.costToNext(i, L.xpBase, L.xpGrowth)} XP`);
    rows.push(`… totalling ${S.totalXpForLevel(Math.min(L.maxLevel, 6), L.xpBase, L.xpGrowth)} XP for level 6`);
    $('curvePrev').textContent = rows.join(' · ');
  }
  const before = featValues(editing);
  const beforeAll = JSON.parse(JSON.stringify(before));
  const after = draft;
  $('edDiff').textContent = diffText(beforeAll, after) || '(identical)';
  updatePreview();
}

function diffText(a, b, path = '') {
  const out = [];
  const walk = (x, y, p) => {
    if (x === y) return;
    if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') {
      if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${p}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) walk(x[k], y[k], p ? `${p}.${k}` : k);
  };
  walk(a, b, path);
  return out.join('\n');
}

/* --------------------------------- saving --------------------------------- */

async function saveCurrent() {
  if (!editing) return;
  if (!state.token) {
    edMsg('Needs a token first: in the Connect card, click “get one →”, tick ONLY the repo Discord-Bot with Contents: Read and write, paste it in the token field, then Connect & load again.', false);
    return;
  }
  const f = S.FEATURES.find((x) => x.key === editing);
  // validate the WHOLE config with the new section swapped in
  const merged = JSON.parse(JSON.stringify(state.config));
  merged[editing] = JSON.parse(JSON.stringify(draft));
  const check = S.validate(merged);
  if (check.errors.length) {
    edMsg(`Not saved: ${check.errors[0]}${check.errors.length > 1 ? ` (+${check.errors.length - 1} more)` : ''}`, false);
    return;
  }
  try {
    edMsg('Committing…', true);
    // Stamp every save. An unchanged config serialises byte-identically, the
    // blob sha would not move, and the bot would see nothing to apply — that is
    // what stopped a re-save from resurrecting a deleted ticket panel. The
    // bot's validate() drops this key, so it is never a setting.
    const text = JSON.stringify({ ...check.config, savedAt: new Date().toISOString() }, null, 2);
    const msg = `dashboard: update ${f.name.toLowerCase()}`;
    let sha = null;
    try {
      const meta = await getFile('config.json');
      sha = meta ? meta.sha : null;
    } catch { /* fall back to cached sha */ }
    let newSha;
    try {
      newSha = await putFile('config.json', text, msg, sha || undefined);
    } catch (e) {
      if (!/409/.test(String(e))) throw e;
      // someone changed config.json between our GET and PUT — take the new
      // sha and retry once (our section still overwrites: last save wins)
      const meta = await getFile('config.json').catch(() => null);
      newSha = await putFile('config.json', text, msg + ' (retry after conflict)', meta ? meta.sha : undefined);
    }
    state.config = check.config;
    state.sha = newSha || sha;
    edMsg('Saved — the bot will apply it within ~20 seconds.', true);
    renderCards();
  } catch (e) {
    edMsg(e.message, false);
  }
}

function edMsg(text, ok) {
  const el = $('edMsg');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

/* --------------------------------- wiring --------------------------------- */

$('btnConnect').addEventListener('click', () => void connect());
$('btnForget').addEventListener('click', () => {
  localStorage.removeItem(LS_CREDS);
  state.token = '';
  $('inToken').value = '';
  $('inToken').placeholder = 'github_pat_…';
  setupMsg('Token forgotten from this browser.', true);
});
$('edClose').addEventListener('click', closeEditor);
$('edRevert').addEventListener('click', () => { if (editing) openEditor(editing); });
$('edSave').addEventListener('click', () => void saveCurrent());
$('overlay').addEventListener('mousedown', (e) => { if (e.target === $('overlay')) closeEditor(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEditor(); });
$('patLink').href = 'https://github.com/settings/personal-access-tokens/new?name=Community%20Bot%20dashboard&description=Edit%20config.json%20from%20the%20dashboard&contents=write';

loadCreds();
setConn('', 'not connected');
renderCards();
void connect(); // auto-reconnect if credentials were stored