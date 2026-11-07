// donors.mjs
//
// Ko-fi supporter board: takes Ko-fi's webhook, keeps lifetime totals in donors-state.json and
// publishes the top of the list as `donorN=amount|name` lines in /now.txt.
//
// Ko-fi has no read API, so everything before the webhook was switched on comes from its
// Supporters CSV, loaded once with tools/donors-seed.mjs.
//
// Emails only ever exist here as keyed hashes (they are how one person's payments add up). They
// are never stored, logged or published.

import crypto from 'node:crypto';
import fs from 'node:fs';

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10000;
const MAX_SEEN_IDS = 5000;      // enough to catch Ko-fi's retries; old ones are also stopped by seededAt
const MAX_NAME_LENGTH = 20;
const MAX_UNCONVERTED = 200;

// What the world's Seven Segment font can draw. `<` and `>` are out on purpose: TextMeshPro would
// read a donor name like `<size=999>` as a formatting tag.
const NOT_DRAWABLE = /[^ !"#$%&()*+,\-./0-9:=?@A-Z[\\\]^_a-z{|}]/g;

export function donorKey(hashKey, email, name) {
  const who = String(email || '').trim().toLowerCase() || `name:${String(name || '').trim().toLowerCase()}`;
  return crypto.createHmac('sha256', hashKey).update(who).digest('hex');
}

export function cleanName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(NOT_DRAWABLE, '')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

export function emptyState() {
  return { version: 1, donors: {}, seen: [], unconverted: [] };
}

function sameToken(a, b) {
  const hash = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { reject(new Error('timeout')); req.destroy(); }, BODY_TIMEOUT_MS);
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { clearTimeout(timer); reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

export function createDonors({ CONFIG, logInfo, logWarn, logErr }) {
  const cfg = CONFIG.donors;
  const hiddenNames = new Set(cfg.hiddenNames.map(n => n.trim().toLowerCase()).filter(Boolean));
  const countedTypes = new Set(cfg.countedTypes.map(t => t.trim().toLowerCase()).filter(Boolean));
  const isHiddenName = name => hiddenNames.has(String(name || '').trim().toLowerCase());

  let state = emptyState();
  let usable = true;   // false when the state file exists but cannot be read: never overwrite it
  let published = [];

  if (fs.existsSync(cfg.stateFile)) {
    try {
      state = { ...emptyState(), ...JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) };
    } catch (e) {
      usable = false;
      logErr(`donors: cannot read ${cfg.stateFile}: ${e.message}. Webhook disabled until this is fixed.`);
    }
  }

  function rebuild() {
    published = Object.values(state.donors)
      .filter(d => !isHiddenName(d.name) && cleanName(d.name).length > 0)
      // Arcade rule for ties: whoever got to that score first stays above.
      .sort((a, b) => b.cents - a.cents || String(a.lastAt).localeCompare(String(b.lastAt)) || a.name.localeCompare(b.name))
      .slice(0, cfg.boardSize)
      .map((d, i) => `donor${i + 1}=${(d.cents / 100).toFixed(2)}|${cleanName(d.name)}`);
  }
  rebuild();

  function save() {
    const tmp = `${cfg.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, cfg.stateFile);
  }

  // Applies one verified payment to `state`. Returns what happened, for the log.
  function apply(pay) {
    const id = String(pay.kofi_transaction_id || '');
    if (id && state.seen.includes(id)) return 'duplicate';

    const remember = () => {
      if (!id) return;
      state.seen.push(id);
      if (state.seen.length > MAX_SEEN_IDS) state.seen.splice(0, state.seen.length - MAX_SEEN_IDS);
    };

    const type = String(pay.type || '').trim().toLowerCase();
    if (!countedTypes.has(type)) { remember(); return `ignored type "${pay.type}"`; }
    // Private payments are left out completely: no row, and no amount added to a public row.
    if (pay.is_public !== true && pay.is_public !== 'true') { remember(); return 'private, not counted'; }

    const cents = Math.round(parseFloat(pay.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return null;

    const at = Date.parse(pay.timestamp);
    const iso = Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString();
    const key = donorKey(cfg.hashKey, pay.email, pay.from_name);
    const existing = state.donors[key];

    // The CSV total already includes anything before that person's last-supported minute.
    if (existing && existing.seededAt && Number.isFinite(at) && at < Date.parse(existing.seededAt)) {
      remember();
      return 'already in the imported total';
    }

    // No exchange rates here: park it for a human rather than add unlike amounts together.
    const currency = String(pay.currency || '').trim().toUpperCase();
    if (currency !== cfg.currency) {
      state.unconverted.push({ at: iso, id, amount: pay.amount, currency, name: cleanName(pay.from_name) });
      if (state.unconverted.length > MAX_UNCONVERTED) state.unconverted.shift();
      remember();
      return `not counted: ${currency} is not ${cfg.currency}, kept in "unconverted"`;
    }

    const name = String(pay.from_name || '').trim();
    if (existing) {
      existing.cents += cents;
      existing.lastAt = iso;
      if (name && !isHiddenName(name)) existing.name = name;
    } else {
      state.donors[key] = { name, cents, lastAt: iso };
    }
    remember();
    return `+${(cents / 100).toFixed(2)} ${currency}`;
  }

  return {
    // `donorN=amount|name` lines for /now.txt.
    lines: () => published,

    async handleWebhook(req, res, sendText) {
      if (req.method !== 'POST') return sendText(req, res, 405, 'POST required');
      if (!cfg.verificationToken || !cfg.hashKey || !usable) return sendText(req, res, 503, 'donors not configured');

      let body;
      try {
        body = await readBody(req);
      } catch {
        return;   // too large, too slow or dropped: the connection is already gone
      }
      let pay;
      try {
        pay = JSON.parse(new URLSearchParams(body).get('data') || '');
      } catch {
        return sendText(req, res, 400, 'Bad payload');
      }
      if (!pay || typeof pay !== 'object' || !sameToken(pay.verification_token || '', cfg.verificationToken)) {
        return sendText(req, res, 403, 'Forbidden');
      }

      const who = cleanName(pay.from_name) || '(no name)';
      if (cfg.dryRun) {
        logInfo(`donors: dry run, nothing saved: ${pay.type} ${pay.amount} ${pay.currency} from ${who}, public=${pay.is_public}, timestamp=${pay.timestamp}`);
        return sendText(req, res, 200, 'ok');
      }

      const before = JSON.stringify(state);
      const outcome = apply(pay);
      if (outcome === null) {
        logWarn(`donors: unusable amount "${pay.amount}" from ${who}`);
        return sendText(req, res, 200, 'ok');   // a retry would not make it any better
      }
      try {
        if (JSON.stringify(state) !== before) save();
      } catch (e) {
        state = JSON.parse(before);
        logErr(`donors: could not save: ${e.message}`);
        return sendText(req, res, 500, 'Could not save');   // Ko-fi retries on a non-200
      }
      rebuild();
      logInfo(`donors: ${who}: ${outcome}`);
      sendText(req, res, 200, 'ok');
    },
  };
}
