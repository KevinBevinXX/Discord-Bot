#!/usr/bin/env node
/**
 * Merges tools/wordlist-starter.txt into a config.json's banned-word list,
 * keeping whatever is already there.
 *
 *     node tools/merge-wordlist.js config.json          # in place
 *     node tools/merge-wordlist.js config.json --dry    # just report
 *
 * Entries already covered by normalisation (b1tch when bitch is present) are
 * dropped rather than stored twice, and the schema's 500-entry cap is honoured.
 */
const fs = require('fs');
const path = require('path');
const { normalizeText } = require('../src/features/automod');

const CAP = 500;

function starterWords() {
  return fs.readFileSync(path.join(__dirname, 'wordlist-starter.txt'), 'utf8')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function merge(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const word of [...existing, ...incoming]) {
    const w = String(word).trim();
    if (!w) continue;
    const key = normalizeText(w);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return { words: out.slice(0, CAP), dropped: Math.max(0, out.length - CAP) };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: merge-wordlist.js <config.json> [--dry]'); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.automod = cfg.automod || {};
  cfg.automod.bannedWords = cfg.automod.bannedWords || {};
  const before = cfg.automod.bannedWords.words || [];
  const { words, dropped } = merge(before, starterWords());
  console.log(`${before.length} existing + ${starterWords().length} starter → ${words.length} unique${dropped ? ` (${dropped} over the ${CAP} cap, dropped)` : ''}`);
  if (process.argv.includes('--dry')) process.exit(0);
  cfg.automod.bannedWords.words = words;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`wrote ${file}`);
}

module.exports = { merge, starterWords };
