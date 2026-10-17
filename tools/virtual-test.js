#!/usr/bin/env node
/**
 * Virtual tester — drives the REAL dashboard in a REAL (headless) browser
 * against a mock GitHub with real sha semantics. Run BEFORE every push:
 *
 *     npm run vtest
 *
 * Covers the whole save loop: connect → edit → save → commit recorded →
 * conflict race (409) → auto-retry → saved anyway. Exits non-zero on failure.
 * Requires headless chrome on :9333 (launched automatically when missing).
 */
const { execFileSync, spawn } = require('child_process');
const http = require('http');

const MOCK_PORT = 8770;
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${MOCK_PORT}`;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function waitFor(cond, ms, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        if (await cond()) return resolve();
      } catch { /* keep waiting */ }
      if (Date.now() - t0 > ms) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

async function ensureChrome() {
  try {
    await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return;
  } catch { /* not running */ }
  const child = spawn('google-chrome', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/kcb-vtest-profile-${Date.now()}`, 'about:blank',
  ], { stdio: 'ignore', detached: true });
  child.unref();
  await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return r.code === 200;
  }, 15000, 'headless chrome did not start');
}

async function newTab(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?` + encodeURIComponent(url), { method: 'PUT' });
  const body = await res.text();
  let tab;
  try {
    tab = JSON.parse(body);
  } catch {
    throw new Error(`json/new returned non-JSON (${res.status}): ${body.slice(0, 120)}`);
  }
  if (!tab.webSocketDebuggerUrl) throw new Error(`json/new gave no ws url: ${body.slice(0, 200)}`);
  return tab.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((ok, bad) => {
    ws.onopen = ok;
    ws.onerror = () => bad(new Error('websocket failed to connect'));
  });
  ready.catch(() => {}); // never an unhandled rejection
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d.result);
      pending.delete(d.id);
    }
  };
  const send = async (method, params = {}) => {
    await ready;
    return new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  };
  const q = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
  return { send, q };
}

async function mockCommits() {
  const r = await getJson(`${BASE}/debug/commits`).catch(() => null);
  if (!r || r.code !== 200) return [];
  return JSON.parse(r.body);
}

(async () => {
  await ensureChrome();

  // mock server (spawned here so the fault injector lives with the test);
  // reuse one already listening (previous run) instead of dying on the port
  let mock = null;
  const already = await getJson(`${BASE}/debug/commits`).catch(() => null);
  if (!already || already.code !== 200) {
    mock = spawn('python3', [require('path').join(__dirname, 'mock-github.py'), String(MOCK_PORT)], { stdio: 'ignore' });
    mock.unref();
    await waitFor(async () => (await getJson(`${BASE}/repos/o/r/contents/config.json`)).code === 200, 8000, 'mock server');
  }
  await waitFor(async () => (await getJson(`${BASE}/repos/o/r/contents/config.json`)).code === 200, 8000, 'mock server');

  const tab = await newTab(`${BASE}/`);
  const { send, q } = connect(tab); // newTab returns the ws URL string
  await send('Runtime.enable');
  await send('Page.enable');
  await new Promise((r) => setTimeout(r, 2500));

  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  };

  // 1. page boots clean, no overlay
  const overlay = await q(`getComputedStyle(document.getElementById('overlay')).display`);
  check('no editor overlay on load', overlay === 'none', overlay);

  // 2. connect against the mock
  await q(`localStorage.clear(); localStorage.setItem('kcb:apiBase', '${BASE}'); 'ok'`);
  await q(`document.getElementById('inOwner').value='Test'; document.getElementById('inRepo').value='Repo'; document.getElementById('inBranch').value='main'; document.getElementById('inToken').value='github_pat_test'; 'ok'`);
  await q(`document.getElementById('btnConnect').click(); void 0;`);
  await new Promise((r) => setTimeout(r, 700));
  const connText = await q(`document.getElementById('connStatus').textContent`);
  check('connects against the mock (no error)', !connText.includes('failed'), connText);

  // 3. tickets editor: category + emoji picker + reason list
  await q(`document.querySelector('.feat[data-feat=tickets]').click(); void 0;`);
  await new Promise((r) => setTimeout(r, 300));
  const catField = await q(`(()=>{const l=[...document.querySelectorAll('#edBody label')].find(x=>x.textContent.includes('Open tickets category'));if(!l)return 'missing';const dl=document.getElementById(l.querySelector('input[list]').getAttribute('list'));return dl && dl.options.length ? 'datalist with ' + dl.options.length + ' options' : 'datalist EMPTY';})()`);
  check('category dropdown has the mock categories', /datalist with 1 option/.test(catField), catField);
  const picker = await q(`(()=>{const b=document.querySelector('.list-item .emoji-btn');if(!b)return 'no button';b.click();const p=document.querySelector('.emoji-pop');if(!p)return 'no popover';const t=[...p.querySelectorAll('.emo')].find(x=>x.dataset.e==='🚩');t.click();return 'picked: '+document.querySelector('.list-item .emoji-input').value;})()`);
  check('emoji picker fills the field', /picked: 🚩/.test(picker), picker);

  // 4. save → commit recorded
  await q(`document.getElementById('edSave').click(); void 0;`);
  await new Promise((r) => setTimeout(r, 600));
  const saved1 = await q(`document.getElementById('edMsg').textContent`);
  check('save succeeds', /Saved/.test(saved1), saved1);
  check('commit landed in mock', (await mockCommits()).some((c) => c.message.includes('tickets')), `${(await mockCommits()).length} commit(s)`);

  // 5. the 409 race: mock hands out a stale sha ONCE → save must retry and still succeed
  await fetch(`${BASE}/debug/stale-once`, { method: 'POST' });
  await q(`document.getElementById('edSave').click(); void 0;`);
  await new Promise((r) => setTimeout(r, 900));
  const saved2 = await q(`document.getElementById('edMsg').textContent`);
  check('save survives a 409 conflict (auto-retry)', /Saved/.test(saved2), saved2);

  // 6. values persisted across reload (localStorage creds + fresh GET)
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2500));
  await q(`document.querySelector('.feat[data-feat=tickets]').click(); void 0;`);
  await new Promise((r) => setTimeout(r, 300));
  const persisted = await q(`document.querySelector('.list-item .emoji-input') ? document.querySelector('.list-item .emoji-input').value : '?'`);
  check('saved emoji still there after reload', persisted === '🚩', JSON.stringify(persisted));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} virtual tests passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => fail(e.stack || e.message));