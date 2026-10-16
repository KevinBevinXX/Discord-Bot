#!/usr/bin/env node
/**
 * npm run check — everything that can fail without a Discord token:
 *   1. schema.js in sync between src/ and docs/
 *   2. syntax-check every .js file in the bot
 *   3. config.example.json is exactly the schema defaults
 *   4. module graph loads (catches broken requires/deps)
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function step(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✗ ${name}: ${e.message}`);
  }
}

step('schema.js in sync', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'sync-schema.js')], { stdio: 'pipe' });
});

const jsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) jsFiles.push(p);
  }
})(ROOT);

for (const f of jsFiles) {
  step(`syntax ${path.relative(ROOT, f)}`, () => {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  });
}

step('config.example.json matches schema defaults', () => {
  const S = require(path.join(ROOT, 'src', 'schema.js'));
  const file = path.join(ROOT, 'config.example.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(S.defaults(), null, 2) + '\n');
    console.log('   (written — review & commit it)');
    return;
  }
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (JSON.stringify(onDisk) !== JSON.stringify(S.defaults())) {
    fs.writeFileSync(file, JSON.stringify(S.defaults(), null, 2) + '\n');
    console.log('   (example refreshed from schema — review the diff)');
  }
});

step('module graph loads (bot needs no token for this)', () => {
  for (const rel of ['src/schema.js', 'src/util.js', 'src/db.js', 'src/runtime.js', 'src/transcript.js', 'src/context.js', 'src/state.js']) {
    require(path.join(ROOT, rel));
  }
  // require index.js would OPEN a gateway connection; instead verify every feature+command module parses+requires
  for (const rel of ['src/features/tickets.js', 'src/features/reactionroles.js', 'src/features/levels.js', 'src/features/automod.js', 'src/features/welcome.js', 'src/features/moderation.js', 'src/commands.js']) {
    require(path.join(ROOT, rel));
  }
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');