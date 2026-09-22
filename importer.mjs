// importer.mjs — optional playlist importer for netradio.js
//
// Drop this file next to netradio.js (it is .mjs on purpose: the Pterodactyl Node egg breaks if two *.js files sit in the folder) and the `import <url> [folder] [max]` console command
// (and POST /import) become available. Without it, netradio.js runs exactly the same minus
// that command. See README "Importing playlists".

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Helpers handed over by netradio.js so this file has no copy of them.
let CONFIG, __dirname, ensureDir, getAudioFilesRecursive, normalizeName, runFfmpeg, logInfo, logWarn, logErr, COLORS;

export function createImporter(ctx, scheduler) {
  ({ CONFIG, __dirname, ensureDir, getAudioFilesRecursive, normalizeName, runFfmpeg, logInfo, logWarn, logErr, COLORS } = ctx);
  return new Importer(scheduler);
}

// ---------------------------------------------------------------------------
// Playlist import: Spotify / YouTube / YouTube Music playlist URL -> songs/<folder>/
//   Spotify tracklist comes from the public embed page (no API key, up to 100 tracks)
//   or the Web API when SPOTIFY_CLIENT_ID/SECRET are set (any size).
//   Each track is looked up on YouTube Music ("songs" results = audio-only uploads),
//   verified by title + duration (+-12 s), downloaded with yt-dlp as mp3 and tagged.
//   Files that already exist in the folder are skipped, so re-importing is cheap.
// ---------------------------------------------------------------------------

const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const BAD_WORDS = ['live', 'remix', 'cover', 'karaoke', 'instrumental', 'sped up', 'slowed', 'nightcore', '8d', 'reverb', 'acoustic', 'reaction', 'tutorial', 'lesson'];

function safeFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
}

function slug(s) {
  return normalizeName(s).slice(0, 40) || 'playlist';
}

function looseTitle(s) {
  // strip "(feat. X)", "- Remastered 2011", "[Official Audio]" etc. for comparisons
  return normalizeName(String(s)
    .replace(/[([{][^)\]}]*(feat|ft\.|with|remaster|version|edit|mix|mono|stereo|live|explicit|bonus|official|audio|video|lyrics)[^)\]}]*[)\]}]/gi, '')
    .replace(/\s-\s(.*remaster.*|.*version.*|.*edit.*|.*mix.*)$/i, ''));
}

function badWordsIn(s, allowed) {
  const t = ` ${normalizeName(s).replace(/-/g, ' ')} `;
  const a = ` ${normalizeName(allowed).replace(/-/g, ' ')} `;
  return BAD_WORDS.filter(w => t.includes(` ${w} `) && !a.includes(` ${w} `));
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, redirect: 'follow' });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200).replace(/\s+/g, ' '); } catch { /* ignore */ }
    throw new Error(`${res.status} ${res.statusText} for ${url}${detail ? ` — ${detail}` : ''}`);
  }
  return res.text();
}

// --- yt-dlp -----------------------------------------------------------------

class YtDlp {
  constructor() {
    this.bin = null;
  }

  async locate() {
    if (this.bin) return this.bin;
    if (this.failed) throw this.failed;
    const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const local = path.join(__dirname, 'bin', name);
    const candidates = [process.env.YTDLP_PATH, local, 'yt-dlp'].filter(Boolean);
    for (const c of candidates) {
      if (await this.works(c)) { this.bin = c; return c; }
    }
    // Not installed: fetch the official release into bin/ (python zipapp on Linux, exe on Windows).
    try {
      ensureDir(path.dirname(local));
      logInfo(`yt-dlp not found; downloading ${YTDLP_RELEASE}${name} -> ${path.relative(__dirname, local)}`);
      const res = await fetch(YTDLP_RELEASE + name, { redirect: 'follow' });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
      if (process.platform !== 'win32') fs.chmodSync(local, 0o755);
      if (!(await this.works(local))) {
        const why = await new Promise(resolve => execFile(local, ['--version'], { windowsHide: true }, (err, _o, stderr) => resolve((stderr || (err && err.message) || '').trim().split(/\r?\n/).pop())));
        throw new Error(`downloaded yt-dlp does not run: ${why || 'unknown error'} (it needs python3)`);
      }
      logInfo(`yt-dlp installed at ${path.relative(__dirname, local)}`);
      this.bin = local;
      return local;
    } catch (e) {
      this.failed = new Error(`yt-dlp unavailable: ${e.message} — set YTDLP_PATH in .env or put yt-dlp in bin/`);
      throw this.failed;
    }
  }

  works(bin) {
    return new Promise(resolve => {
      execFile(bin, ['--version'], { windowsHide: true }, err => resolve(!err));
    });
  }

  baseArgs() {
    const args = ['--ignore-config', '--no-warnings', '--no-playlist-reverse'];
    if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);
    if (process.env.YTDLP_ARGS) args.push(...process.env.YTDLP_ARGS.split(/\s+/).filter(Boolean));
    return args;
  }

  async run(args, opts = {}) {
    const bin = await this.locate();
    const full = [...this.baseArgs(), ...args];
    const [cmd, ...rest] = process.platform === 'win32' ? [bin, ...full] : ['nice', '-n', '19', bin, ...full];
    if (process.env.IMPORT_DEBUG) logInfo(`[yt-dlp] ${args.join(' ')}`);
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      execFile(cmd, rest, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 300000 }, (err, stdout, stderr) => {
        if (process.env.IMPORT_DEBUG) logInfo(`[yt-dlp] ${err ? 'ERR' : 'ok'} in ${Date.now() - t0}ms${err ? `: ${String(stderr || err.message).trim().slice(-300)}` : ''}`);
        if (err) reject(new Error((stderr || err.message).trim().split(/\r?\n/).filter(l => /ERROR|error/i.test(l)).pop() || err.message));
        else resolve(stdout);
      });
    });
  }

  async jsonLines(args, opts) {
    const out = await this.run(args, opts);
    return out.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  async update() {
    const bin = await this.locate();
    return new Promise(resolve => {
      execFile(bin, ['-U'], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => resolve((stdout || stderr || (err && err.message) || '').trim().split(/\r?\n/).pop()));
    });
  }
}

// --- sources ------------------------------------------------------------------

function parseSpotifyPlaylistId(url) {
  const m = /(?:open\.spotify\.com\/(?:embed\/)?playlist\/|spotify:playlist:)([A-Za-z0-9]+)/.exec(url);
  return m ? m[1] : null;
}

async function spotifyTracksViaEmbed(id) {
  const html = await fetchText(`https://open.spotify.com/embed/playlist/${id}`);
  const m = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s.exec(html);
  if (!m) throw new Error('could not read the Spotify embed page (playlist private or blocked?)');
  const entity = JSON.parse(m[1]).props.pageProps.state.data.entity;
  const tracks = (entity.trackList || []).map(t => ({
    artist: t.subtitle || '',
    title: t.title || '',
    durationSec: t.duration ? t.duration / 1000 : null,
  }));
  return { name: entity.name || `spotify-${id}`, tracks, truncated: tracks.length >= 100 };
}

// --- Spotify user login (Authorization Code flow) --------------------------------
// Spotify no longer gives app-only tokens playlist contents; a token for the app owner's
// own account still works. One-time browser login via /spotify/login stores a refresh
// token in spotify-auth.json next to the server.

const SPOTIFY_SCOPES = 'playlist-read-private playlist-read-collaborative';

function spotifyAuthFile() { return path.join(__dirname, 'spotify-auth.json'); }
function spotifyRedirectUri() { return `${(CONFIG.publicUrl || '').replace(/[/]+$/, '')}/spotify/callback`; }
function spotifyCreds() {
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  return id && secret ? { id, secret, basic: Buffer.from(`${id}:${secret}`).toString('base64') } : null;
}

function readSpotifyAuth() {
  try { return JSON.parse(fs.readFileSync(spotifyAuthFile(), 'utf8')); } catch { return null; }
}

async function spotifyTokenRequest(body) {
  const creds = spotifyCreds();
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds.basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify token request failed: ${res.status} ${json.error_description || json.error || ''}`.trim());
  return json;
}

// Access token for API calls: user token if logged in, else app-only.
async function spotifyAccessToken() {
  const saved = readSpotifyAuth();
  if (saved && saved.refresh_token) {
    const t = await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refresh_token });
    if (t.refresh_token && t.refresh_token !== saved.refresh_token) {
      fs.writeFileSync(spotifyAuthFile(), JSON.stringify({ ...saved, refresh_token: t.refresh_token }, null, 2));
    }
    return { token: t.access_token, user: saved.user || 'user' };
  }
  const t = await spotifyTokenRequest({ grant_type: 'client_credentials' });
  return { token: t.access_token, user: null };
}

const pendingSpotifyStates = new Set();

function spotifyLoginUrl() {
  if (!spotifyCreds()) return null;
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  pendingSpotifyStates.add(state);
  setTimeout(() => pendingSpotifyStates.delete(state), 10 * 60 * 1000).unref();
  const q = new URLSearchParams({ client_id: spotifyCreds().id, response_type: 'code', redirect_uri: spotifyRedirectUri(), scope: SPOTIFY_SCOPES, state });
  return `https://accounts.spotify.com/authorize?${q}`;
}

async function spotifyFinishLogin(code, state) {
  if (!pendingSpotifyStates.has(state)) throw new Error('login state mismatch or expired; start again from /spotify/login');
  pendingSpotifyStates.delete(state);
  const t = await spotifyTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: spotifyRedirectUri() });
  let user = 'user';
  try {
    const me = JSON.parse(await fetchText('https://api.spotify.com/v1/me', { Authorization: `Bearer ${t.access_token}` }));
    user = me.display_name || me.id || user;
  } catch { /* fine */ }
  fs.writeFileSync(spotifyAuthFile(), JSON.stringify({ refresh_token: t.refresh_token, user, since: new Date().toISOString() }, null, 2));
  return user;
}

function spotifyStatus() {
  const creds = spotifyCreds();
  if (!creds) return 'Spotify API not configured (SPOTIFY_CLIENT_ID/SECRET in .env); using the embed page (lags edits, max 100 tracks)';
  const saved = readSpotifyAuth();
  if (saved && saved.refresh_token) return `Spotify: logged in as ${saved.user} since ${saved.since} — playlist reads are live`;
  if (!CONFIG.publicUrl) return 'Spotify: keys set but PUBLIC_URL missing in .env (needed for the login redirect)';
  return `Spotify: keys set, not logged in. Open ${CONFIG.publicUrl.replace(/[/]+$/, '')}/spotify/login?token=<ADMIN_TOKEN> (redirect URI in your Spotify app must be exactly ${spotifyRedirectUri()})`;
}

async function spotifyTracksViaApi(id) {
  const { token, user } = await spotifyAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  const tracks = [];
  const addPage = page => {
    for (const it of page.items || []) {
      const t = it.track || it.item;
      if (t && t.name) tracks.push({ artist: (t.artists || []).map(a => a.name).join(', '), title: t.name, durationSec: t.duration_ms / 1000 });
    }
    return page.next;
  };
  const meta = JSON.parse(await fetchText(`https://api.spotify.com/v1/playlists/${id}`, headers));
  let container = [meta.tracks, meta.items].find(c => c && Array.isArray(c.items));
  if (!container) {
    // item list stripped from the object: try the paging endpoints directly (old and new names)
    let lastErr = null;
    for (const ep of ['items', 'tracks']) {
      try { container = JSON.parse(await fetchText(`https://api.spotify.com/v1/playlists/${id}/${ep}?limit=100`, headers)); break; } catch (e) { lastErr = e; }
    }
    if (!container) throw new Error(`no playlist items via API${user ? '' : ' (app-only token; log in with /spotify/login)'}: ${lastErr ? lastErr.message.slice(0, 120) : 'unknown'}`);
  }
  let next = addPage(container);
  let truncated = false;
  while (next) {
    try {
      next = addPage(JSON.parse(await fetchText(next, headers)));
    } catch (e) {
      logWarn(`Spotify refused paging past ${tracks.length} tracks (${e.message.slice(0, 120)}); importing what it gave`);
      truncated = true;
      break;
    }
  }
  if (!tracks.length) throw new Error('API returned an empty track list');
  logInfo(`Spotify: read ${tracks.length} tracks via API${user ? ` as ${user}` : ' (app-only token)'}`);
  return { name: meta.name, tracks, truncated };
}

async function youtubeTracks(ytdlp, url) {
  const entries = await ytdlp.jsonLines(['--flat-playlist', '-J', url], { timeout: 120000 });
  const root = entries[0] || {};
  const list = root.entries || [root];
  return {
    name: root.title || 'youtube',
    tracks: list.filter(e => e && (e.id || e.url)).map(e => ({ artist: e.artist || e.uploader || e.channel || '', title: e.track || e.title || '', durationSec: e.duration || null, videoId: e.id })),
    truncated: false,
  };
}

// --- matching + download -----------------------------------------------------

class Importer {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.ytdlp = new YtDlp();
    this.queue = [];
    this.current = null;
    this.log = [];
  }

  // HTTP routes owned by the importer: /spotify/login and /spotify/callback. Returns true if handled.
  async handleHttp(req, res, url, sendText, authorized) {
    if (url.pathname === '/spotify/login') {
      if (!authorized(url)) return sendText(req, res, 403, 'Forbidden (token=ADMIN_TOKEN)'), true;
      const to = spotifyLoginUrl();
      if (!to) return sendText(req, res, 400, 'SPOTIFY_CLIENT_ID/SECRET not set'), true;
      const uri = spotifyRedirectUri();
      if (!/^https:[/][/]/.test(uri) && !/^http:[/][/]127[.]0[.]0[.]1/.test(uri)) {
        return sendText(req, res, 400, `Spotify requires an https redirect URI; PUBLIC_URL in .env must be https://... (currently gives "${uri}")`), true;
      }
      res.writeHead(302, { Location: to });
      res.end();
      return true;
    }
    if (url.pathname === '/spotify/callback') {
      try {
        if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error'));
        const user = await spotifyFinishLogin(url.searchParams.get('code') || '', url.searchParams.get('state') || '');
        logInfo(`Spotify: logged in as ${user}`);
        sendText(req, res, 200, `Spotify linked as ${user}. You can close this tab; imports now read your playlists live.`);
      } catch (e) {
        logErr(`Spotify login failed: ${e.message}`);
        sendText(req, res, 400, `Spotify login failed: ${e.message}`);
      }
      return true;
    }
    return false;
  }

  spotifyStatus() { return spotifyStatus(); }

  status() {
    return { running: this.current, queued: this.queue.map(j => j.url), recent: this.log.slice(-10) };
  }

  enqueue(url, folder, limit = 0) {
    if (!/^(https?:\/\/|spotify:)/i.test(url)) return 'usage: import <spotify|youtube playlist url> [folder] [max tracks]';
    this.queue.push({ url, folder, limit });
    if (!this.current) this.drain().catch(e => logErr(`import: ${e.message}`));
    return this.queue.length + (this.current ? 1 : 0) > 1 ? `queued (${this.queue.length} waiting)` : 'import started — watch the console';
  }

  async drain() {
    while (this.queue.length) {
      const job = this.queue.shift();
      this.current = { url: job.url, folder: job.folder, done: 0, total: 0, ok: 0, skipped: 0, failed: 0 };
      try {
        await this.runJob(job);
      } catch (e) {
        logErr(`import failed: ${e.message}`);
      }
      this.log.push({ ...this.current, finishedAt: new Date().toISOString() });
      this.current = null;
    }
  }

  async resolveSource(url) {
    const spotifyId = parseSpotifyPlaylistId(url);
    if (spotifyId) {
      if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
        try {
          return await spotifyTracksViaApi(spotifyId);
        } catch (e) {
          logWarn(`Spotify API failed (${e.message.slice(0, 200)}); falling back to the embed page`);
        }
      }
      const r = await spotifyTracksViaEmbed(spotifyId);
      if (r.truncated) logWarn('Spotify embed only exposes the first 100 tracks; set SPOTIFY_CLIENT_ID/SECRET in .env for bigger playlists');
      return r;
    }
    if (/youtube\.com|youtu\.be/i.test(url)) return youtubeTracks(this.ytdlp, url);
    throw new Error('unsupported URL (Spotify or YouTube/YouTube Music playlist expected)');
  }

  existingKeys(dir) {
    const keys = new Set();
    for (const f of getAudioFilesRecursive(dir)) keys.add(looseTitle(path.basename(f, path.extname(f))));
    return keys;
  }

  async findOnYouTube(track) {
    const want = looseTitle(track.title);
    const wantArtist = normalizeName(track.artist.split(',')[0]);
    const q = encodeURIComponent(`${track.artist.split(',')[0]} ${track.title}`);
    const seen = new Set();
    const candidates = [];

    // 1. YouTube Music "songs" results (audio-only, properly tagged)
    try {
      for (const e of await this.ytdlp.jsonLines(['--flat-playlist', '--playlist-end', '5', '-j', `https://music.youtube.com/search?q=${q}#songs`], { timeout: 60000 })) {
        if (e.id && !seen.has(e.id)) { seen.add(e.id); candidates.push({ id: e.id, title: e.title || '' }); }
      }
    } catch (e) { logWarn(`youtube music search failed: ${e.message}`); }
    // 2. plain YouTube search as a fallback (durations available up front)
    if (candidates.length < 3) {
      try {
        for (const e of await this.ytdlp.jsonLines(['--flat-playlist', '-j', `ytsearch5:${track.artist.split(',')[0]} - ${track.title}`], { timeout: 60000 })) {
          if (e.id && !seen.has(e.id)) { seen.add(e.id); candidates.push({ id: e.id, title: e.title || '', duration: e.duration, channel: e.channel || e.uploader || '' }); }
        }
      } catch (e) { logWarn(`youtube search failed: ${e.message}`); }
    }

    for (const c of candidates) {
      const ct = looseTitle(c.title);
      const titleOk = ct.includes(want) || want.includes(ct);
      if (!titleOk) continue;
      if (badWordsIn(c.title, track.title).length) continue;
      // verify with full metadata (duration, artist, album)
      let meta;
      try { [meta] = await this.ytdlp.jsonLines(['-j', '--no-download', `https://www.youtube.com/watch?v=${c.id}`], { timeout: 60000 }); } catch (e) { logWarn(`lookup failed for ${c.id}: ${e.message}`); continue; }
      if (!meta) continue;
      const dur = meta.duration || c.duration;
      if (track.durationSec && dur && Math.abs(dur - track.durationSec) > 12) continue;
      const channel = `${meta.channel || ''} ${meta.uploader || ''} ${meta.artist || ''}`;
      if (wantArtist && !normalizeName(channel).includes(wantArtist) && !normalizeName(meta.title || '').includes(wantArtist)) {
        // artist not mentioned anywhere: only accept if the duration matched tightly
        if (!(track.durationSec && dur && Math.abs(dur - track.durationSec) <= 3)) continue;
      }
      return { id: c.id, duration: dur, album: meta.album || '', year: meta.release_year || '' };
    }
    return null;
  }

  async download(track, videoId, dir, extra = {}) {
    const artist = track.artist || 'Unknown Artist';
    const base = safeFilename(`${artist} - ${track.title}`);
    const tmp = path.join(dir, `.${base}.dl.%(ext)s`);
    const final = path.join(dir, `${base}.mp3`);
    const dlArgs = ['--no-playlist', '--retries', '3', '--fragment-retries', '3', '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', tmp, `https://www.youtube.com/watch?v=${videoId}`];
    try {
      await this.ytdlp.run(dlArgs, { timeout: 600000 });
    } catch (e) {
      // YouTube often 403s the first attempt at a fresh video; one more go after a pause
      logWarn(`download failed (${e.message.slice(0, 80)}), retrying once`);
      await new Promise(r => setTimeout(r, 3000));
      await this.ytdlp.run(dlArgs, { timeout: 600000 });
    }
    const dl = path.join(dir, `.${base}.dl.mp3`);
    if (!fs.existsSync(dl)) throw new Error('download produced no file');
    // tag with the playlist's artist/title (what the radio shows), then move into place
    const tagged = path.join(dir, `.${base}.tag.mp3`);
    const meta = ['-metadata', `title=${track.title}`, '-metadata', `artist=${artist}`];
    if (extra.album) meta.push('-metadata', `album=${extra.album}`);
    if (extra.year) meta.push('-metadata', `date=${extra.year}`);
    await runFfmpeg(['-i', dl, '-map', '0:a', '-c', 'copy', '-map_metadata', '-1', ...meta, '-id3v2_version', '3', tagged]);
    fs.unlinkSync(dl);
    fs.renameSync(tagged, final);
    return final;
  }

  async runJob(job) {
    logInfo(`import: reading ${job.url}`);
    await this.ytdlp.locate(); // fail the whole job with a clear message if yt-dlp cannot run
    const src = await this.resolveSource(job.url);
    const folder = job.folder || slug(src.name);
    const dir = folder === 'default' ? CONFIG.songsDir : path.join(CONFIG.songsDir, folder);
    ensureDir(dir);
    const have = this.existingKeys(dir);
    if (job.limit > 0) src.tracks = src.tracks.slice(0, job.limit);
    const todo = src.tracks.filter(t => t.title && !have.has(looseTitle(`${t.artist} - ${t.title}`)) && !have.has(looseTitle(t.title)));
    this.current.total = src.tracks.length;
    this.current.skipped = src.tracks.length - todo.length;
    logInfo(`import: "${src.name}" -> songs/${folder}: ${src.tracks.length} tracks, ${todo.length} to fetch, ${this.current.skipped} already present`);
    const misses = [];

    for (const [i, t] of todo.entries()) {
      const label = `${t.artist ? `${t.artist} - ` : ''}${t.title}`;
      try {
        let match = t.videoId ? { id: t.videoId } : await this.findOnYouTube(t);
        if (!match) {
          misses.push(label);
          this.current.failed += 1;
          logWarn(`[import ${i + 1}/${todo.length}] no confident match: ${label}`);
          continue;
        }
        const file = await this.download(t, match.id, dir, match);
        this.current.ok += 1;
        logInfo(`[import ${i + 1}/${todo.length}] ${COLORS.green}ok${COLORS.reset} ${path.basename(file)}${match.duration ? ` (${Math.round(match.duration)}s)` : ''}`);
        this.scheduler.refresh();
      } catch (e) {
        misses.push(label);
        this.current.failed += 1;
        logErr(`[import ${i + 1}/${todo.length}] failed: ${label}: ${e.message}`);
      }
      this.current.done = i + 1;
    }
    logInfo(`import done: ${this.current.ok} downloaded, ${this.current.skipped} already there, ${this.current.failed} missed` +
      (this.current.ok && !this.scheduler.active.includes(folder) && !this.scheduler.active.includes('all') ? ` — switch with: playlist ${folder}` : ''));
    if (misses.length) {
      const report = path.join(dir, 'import-misses.txt');
      fs.writeFileSync(report, `${new Date().toISOString()} ${job.url}\n${misses.join('\n')}\n`, { flag: 'a' });
      logWarn(`missed tracks listed in ${path.relative(__dirname, report)} — add those by hand`);
    }
  }
}

