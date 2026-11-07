// donors-seed.mjs — turn Ko-fi's Supporters CSV into a starting donors-state.json.
//
//   DONOR_HASH_KEY=<same value as the server's> node tools/donors-seed.mjs Supporters.csv [donors-state.json]
//
// Run it on your own machine and upload only the output: emails become keyed hashes, so the CSV
// itself never needs to reach the server. Refuses to replace an existing output file, because
// that file may already hold payments that came in through the webhook.

import fs from 'node:fs';
import { donorKey, emptyState } from '../donors.mjs';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.length > 0));
}

const [csvPath, outPath = 'donors-state.json'] = process.argv.slice(2);
const hashKey = process.env.DONOR_HASH_KEY;
if (!csvPath || !hashKey) {
  console.error('usage: DONOR_HASH_KEY=<key> node tools/donors-seed.mjs Supporters.csv [donors-state.json]');
  process.exit(1);
}
if (fs.existsSync(outPath)) {
  console.error(`${outPath} already exists; not replacing it`);
  process.exit(1);
}

const [header, ...rows] = parseCsv(fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, ''));
const col = name => {
  const i = header.indexOf(name);
  if (i < 0) { console.error(`CSV has no "${name}" column`); process.exit(1); }
  return i;
};
const NAME = col('Name'), EMAIL = col('Email'), COMMISSION = col('Commission'), SHOP = col('Shop');
const LAST = col('LastSupportedDateUTC'), TOTAL = col('Total'), LATEST = col('LastestTransactionId');

const state = emptyState();
for (const r of rows) {
  const cents = Math.round(parseFloat(r[TOTAL]) * 100);
  if (!Number.isFinite(cents) || cents <= 0) continue;
  // The export gives one Total per person, so shop and commission money cannot be separated out.
  if (r[COMMISSION] === 'True' || r[SHOP] === 'True') console.warn(`check by hand: "${r[NAME]}" has commission or shop purchases that may be in their total`);
  const at = new Date(`${r[LAST].replace(' ', 'T')}:00Z`).toISOString();
  state.donors[donorKey(hashKey, r[EMAIL], r[NAME])] = { name: r[NAME], cents, lastAt: at, seededAt: at };
  if (r[LATEST]) state.seen.push(r[LATEST]);
}

fs.writeFileSync(outPath, JSON.stringify(state, null, 2));
const count = Object.keys(state.donors).length;
const sum = Object.values(state.donors).reduce((a, d) => a + d.cents, 0);
console.log(`wrote ${outPath}: ${count} supporters, ${(sum / 100).toFixed(2)} total`);
