/**
 * Small local runtime state that must survive restarts but should NOT live in
 * the GitHub config (message IDs we created, escalation bookmarks).
 * data/runtime.json — read eagerly, write-behind with a short debounce.
 */
const fs = require('fs');
const path = require('path');
const { log } = require('./util');

const FILE = path.join(process.cwd(), 'data', 'runtime.json');
let data = {};
let saveTimer = null;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    data = {};
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      log('runtime', `could not save: ${e.message}`);
    }
  }, 300);
  saveTimer.unref();
}

function get(key, fallback) {
  const v = data[key];
  return v === undefined ? fallback : v;
}

function set(key, value) {
  data[key] = value;
  save();
}

module.exports = { load, get, set, _flush: save };