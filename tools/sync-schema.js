#!/usr/bin/env node
/**
 * Copies src/schema.js into docs/ so the dashboard and the bot share one
 * source of truth. Run in npm run check; the check FAILS if the copy drifted.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'schema.js');
const dst = path.join(__dirname, '..', 'docs', 'schema.js');

const source = fs.readFileSync(src, 'utf8');
let ok = true;
try {
  const existing = fs.readFileSync(dst, 'utf8');
  if (existing !== source) ok = false;
} catch {
  ok = false;
}
if (!ok) {
  fs.writeFileSync(dst, source);
  console.log(`synced schema.js -> docs/schema.js (${source.length} bytes)`);
} else {
  console.log('schema.js already in sync');
}