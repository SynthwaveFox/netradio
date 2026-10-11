// netradio.js
//
// Self-contained live "netradio" server: one real-time MP3 encoder, one shared
// playhead, every listener hears the same thing at (almost) the same moment.
//
//   songs/           -> shuffled music library
//   intros/songs/    -> optional song-specific intros ("artist-title.mp3")
//   intros/generic/  -> generic bumpers played before songs
//
// Endpoints:
//   GET  /radio.mp3   live MP3 stream (Icecast-style: audio/mpeg, no length, icy-* headers)
//   GET  /now.json    what is playing right now, position, listeners, up next
//   GET  /history.json last played tracks
//   GET  /            tiny web player + now-playing page
//   GET  /health      "ok"
//   GET  /hls/live.m3u8  HLS mirror of the same stream — use this URL in VRChat (HLS=0 disables)
//   POST /skip?token=  skip current track (ADMIN_TOKEN must be set)
//   POST /seek?token=&by=30 | &to=90   seek within the current track
//   POST /reload?token= rescan the library
//
// Console commands on stdin: skip | seek +30 | seek 1:30 | now | queue | listeners | reload | stop
//
// Requires ffmpeg + ffprobe on PATH.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Optional .env next to this file (handy on Pterodactyl, where the panel only
// exposes egg-defined variables). Real environment variables win.
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
} catch { /* ignore */ }

// A timezone the platform actually knows, else null (so a typo cannot break the clock).
function validTimezone(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    console.error(`[config] unknown STATION_TZ "${tz}" — falling back to America/New_York`);
    return null;
  }
}

const CONFIG = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || process.env.SERVER_PORT || 3722), // SERVER_PORT = Pterodactyl allocation
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  mount: process.env.MOUNT || '/radio.mp3',
  publicUrl: process.env.PUBLIC_URL || '', // e.g. https://radio.example.com (used in /now.json + page)

  songsDir: process.env.SONGS_DIR || path.join(__dirname, 'songs'),
  songIntrosDir: process.env.SONG_INTROS_DIR || path.join(__dirname, 'intros', 'songs'),
  genericBumpersDir: process.env.GENERIC_BUMPERS_DIR || path.join(__dirname, 'intros', 'generic'),

  bitrate: Number(process.env.BITRATE || 192),      // kbps, CBR mp3
  sampleRate: 44100,
  channels: 2,
  volume: Number(process.env.VOLUME || 1),          // linear gain applied per track
  normalize: process.env.NORMALIZE !== '0',         // align each track's loudness with ONE fixed gain (no dynamic processing)
  normalizeTarget: Number(process.env.NORMALIZE_TARGET || -16), // LUFS
  normalizePeak: Number(process.env.NORMALIZE_PEAK || -1),      // dBTP ceiling: gain is reduced rather than clipping
  bumperOffsetDb: Number(process.env.BUMPER_OFFSET_DB ?? -3),   // bumpers/intros sit this much below the songs

  hourlyIntrosDir: process.env.HOURLY_INTROS_DIR || path.join(__dirname, 'intros', 'hourly'),
  hourlyGraceMinutes: Number(process.env.HOURLY_GRACE_MINUTES || 20), // skip the time check if the break comes later than this
  timezone: validTimezone(process.env.STATION_TZ) || 'America/New_York', // NOT process.env.TZ: containers set that to UTC
  bumperEvery: Number(process.env.BUMPER_EVERY || 1), // generic bumper before every Nth song (0 = never)
  playlist: process.env.PLAYLIST || 'default',   // songs/<folder> to play; 'default' = loose files in songs/; 'all'; or 'a,b'
  playlistOrder: process.env.PLAYLIST_ORDER === 'sequential' ? 'sequential' : 'random', // startup default before any saved choice

  burstSeconds: Number(process.env.BURST_SECONDS || 8), // pre-roll sent to new listeners (player cushion)
  maxClientBacklog: Number(process.env.MAX_CLIENT_BACKLOG || 1024 * 1024), // drop slow clients
  icyMetaInt: 16000,

  name: process.env.STATION_NAME || 'Gizmo Radio',
  description: process.env.STATION_DESCRIPTION || 'Continuous shuffled songs with bumpers',
  genre: process.env.STATION_GENRE || 'Mixed',

  hls: process.env.HLS !== '0',                     // HLS is what VRChat/AVPro plays cleanly
  hlsDir: process.env.HLS_DIR || path.join(__dirname, 'hls'),
  hlsBitrate: Number(process.env.HLS_BITRATE || 128),
  hlsSegmentSeconds: Number(process.env.HLS_SEGMENT_SECONDS || 4),
  hlsListenerTimeout: Number(process.env.HLS_LISTENER_TIMEOUT || 30), // seconds of silence before an HLS client is counted as gone
  hlsWindowSegments: Number(process.env.HLS_WINDOW_SEGMENTS || 6),  // playlist length. Players start at its FIRST segment, so this is the tune-in delay
  hlsKeepSegments: Number(process.env.HLS_KEEP_SEGMENTS || 15),     // extra expired segments kept on disk for players that fell behind

  adminToken: process.env.ADMIN_TOKEN || '',
  exportsDir: process.env.EXPORTS_DIR || path.join(__dirname, 'exports'), // archive renders (not part of the stream)

  // Raw bumper processing (see RawProcessor): intros/raw -> intros/generic
  rawIntrosDir: process.env.RAW_INTROS_DIR || path.join(__dirname, 'intros', 'raw'),
  get rawCleanIntrosDir() { return process.env.RAW_CLEAN_INTROS_DIR || path.join(this.rawIntrosDir, 'clean'); }, // gain only, no echo
  processEchoDelayMs: Number(process.env.PROCESS_ECHO_DELAY_MS || 10),   // Audacity Echo "delay time" 0.01 s
  processEchoDecay: Number(process.env.PROCESS_ECHO_DECAY || 0.5),      // Audacity Echo "decay factor"
  processPeakDb: Number(process.env.PROCESS_PEAK_DB || -1),             // peak-normalise target

  // Broadcast voice chain applied to raw bumpers before the echo. Each stage can be turned
  // off on its own; thresholds are in dB and converted to the linear values ffmpeg wants.
  voiceChain: process.env.VOICE_CHAIN !== '0',
  voiceInputTargetLufs: Number(process.env.VOICE_INPUT_TARGET_LUFS ?? -20), // level the raw take to this before the dynamics
  voiceHpfHz: Number(process.env.VOICE_HPF_HZ ?? 100),                  // 0 = no high-pass
  voiceExpander: process.env.VOICE_EXPANDER !== '0',
  voiceExpThresholdDb: Number(process.env.VOICE_EXPANDER_THRESHOLD_DB ?? -32),
  voiceExpRatio: Number(process.env.VOICE_EXPANDER_RATIO ?? 2),
  voiceExpRangeDb: Number(process.env.VOICE_EXPANDER_RANGE_DB ?? -16),  // most it may duck by
  voiceExpAttackMs: Number(process.env.VOICE_EXPANDER_ATTACK_MS ?? 5),
  voiceExpReleaseMs: Number(process.env.VOICE_EXPANDER_RELEASE_MS ?? 180),
  voiceDeess: process.env.VOICE_DEESS !== '0',
  voiceDeessIntensity: Number(process.env.VOICE_DEESS_INTENSITY ?? 0.6),
  voiceDeessMax: Number(process.env.VOICE_DEESS_MAX ?? 0.5),
  voiceDeessFreq: Number(process.env.VOICE_DEESS_FREQ ?? 0.5),          // 0..1, higher = higher band
  voiceEq: process.env.VOICE_EQ !== '0',
  voiceEqHz: Number(process.env.VOICE_EQ_HZ ?? 3500),                   // presence / clarity
  voiceEqGainDb: Number(process.env.VOICE_EQ_GAIN_DB ?? 4),
  voiceEqQ: Number(process.env.VOICE_EQ_Q ?? 1),
  voiceComp: process.env.VOICE_COMP !== '0',
  voiceCompThresholdDb: Number(process.env.VOICE_COMP_THRESHOLD_DB ?? -24),
  voiceCompRatio: Number(process.env.VOICE_COMP_RATIO ?? 3),
  voiceCompAttackMs: Number(process.env.VOICE_COMP_ATTACK_MS ?? 8),
  voiceCompReleaseMs: Number(process.env.VOICE_COMP_RELEASE_MS ?? 120),
  voiceCompMakeupDb: Number(process.env.VOICE_COMP_MAKEUP_DB ?? 0),
  voiceLimit: process.env.VOICE_LIMIT !== '0',
  voiceLimitCeilingDb: Number(process.env.VOICE_LIMIT_CEILING_DB ?? -1),
};

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus']);

// PCM timeline: s16le stereo 44.1k
const PCM_FRAME = CONFIG.channels * 2;                       // bytes per sample frame
const PCM_BPS = CONFIG.sampleRate * PCM_FRAME;               // bytes per second
const TICK_MS = 50;
const TICK_BYTES = Math.round((PCM_BPS * TICK_MS) / 1000 / PCM_FRAME) * PCM_FRAME;
const MAX_CATCHUP_BYTES = PCM_BPS * 3;                       // if we fall further behind, skip time instead of bursting
const DECODER_HIGH_WATER = PCM_BPS * 8;                      // per-track read-ahead
const DECODER_LOW_WATER = PCM_BPS * 4;

// ---------------------------------------------------------------------------
// Logging (same style as the range file server)
// ---------------------------------------------------------------------------

const COLORS = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m' };

// Log clock = station clock (CONFIG.timezone), so the log and the time checks can never
// disagree about what hour it is.
function stationClockString() {
  const d = new Date();
  const time = d.toLocaleString('en-US', { timeZone: CONFIG.timezone, hour12: false });
  let zone = CONFIG.timezone;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.timezone, timeZoneName: 'short' }).formatToParts(d);
    zone = (parts.find(p => p.type === 'timeZoneName') || {}).value || zone;
  } catch { /* keep the zone id */ }
  return `${time} ${zone}`;
}

function stamp() {
  return `${COLORS.cyan}[${stationClockString()}]${COLORS.reset}`;
}

function logReq(req, status, extra = '') {
  const color = status >= 400 ? COLORS.red : status >= 300 ? COLORS.yellow : COLORS.green;
  console.log(`${stamp()} ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${color}${status}${COLORS.reset} ${extra}`);
}

function logInfo(msg) { console.log(`${stamp()} ${msg}`); }
function logWarn(msg) { console.log(`${stamp()} ${COLORS.yellow}${msg}${COLORS.reset}`); }
function logErr(msg) { console.error(`${stamp()} ${COLORS.red}${msg}${COLORS.reset}`); }

// ---------------------------------------------------------------------------
// Library / scheduling
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Dot-prefixed names are skipped: that is what in-progress downloads and processing
// temporaries are called, and a half-written file must never reach the air.
function getAudioFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...getAudioFilesRecursive(full));
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

function normalizeName(input) {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function parseSongInfo(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const parts = base.split(' - ');
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), base };
  }
  return { artist: '', title: base.trim(), base };
}

function pickRandom(array) {
  return array.length ? array[Math.floor(Math.random() * array.length)] : null;
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Top-of-hour time checks: intros/hourly/<hour>.mp3
//
// At the first break after the hour turns, the generic bumper (or song intro) is
// replaced by that hour's clip — once per hour. A song playing across the hour is
// never cut off; the announcement waits for the break. If that break comes more
// than HOURLY_GRACE_MINUTES after the hour, the clip is skipped rather than
// announcing a time that is already wrong.
//
// File names: 24-hour (0..23, 00..23) or 12-hour with am/pm (1am, 12pm, 9PM).
// An optional "hour" prefix and a "-something" suffix are allowed, so
// "hour-21-evening.mp3" and "21.mp3" both mean 9pm. Several files for the same
// hour are picked between at random.
// ---------------------------------------------------------------------------

const HOURLY_STATE_FILE = path.join(__dirname, 'hourly-state.json');

// "9pm" / "21" / "hour-21-evening" -> 21, or null
function parseHourName(base) {
  const m = /^(?:hour-?)?(\d{1,2})(am|pm)?(?:-.*)?$/.exec(normalizeName(base));
  if (!m) return null;
  let h = Number(m[1]);
  const suffix = m[2];
  if (suffix) {
    if (h < 1 || h > 12) return null;
    if (suffix === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  }
  return h >= 0 && h <= 23 ? h : null;
}

// Local parts of `date` in the station's timezone.
function stationNow(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const hour = Number(p.hour) % 24;
  return { key: `${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, '0')}`, hour, minute: Number(p.minute) };
}

function readHourlyState() {
  try { return JSON.parse(fs.readFileSync(HOURLY_STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeHourlyState(state) {
  try { fs.writeFileSync(HOURLY_STATE_FILE, JSON.stringify(state)); } catch (e) { logWarn(`could not save hourly state: ${e.message}`); }
}

const PLAYLIST_STATE_FILE = path.join(__dirname, 'playlist-state.json');

// The live playlist choice survives restarts; `playlist reset` goes back to .env.
function readPlaylistState() {
  try { return JSON.parse(fs.readFileSync(PLAYLIST_STATE_FILE, 'utf8')); } catch { return null; }
}

function writePlaylistState(state) {
  try { fs.writeFileSync(PLAYLIST_STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { logWarn(`could not save playlist state: ${e.message}`); }
}

function clearPlaylistState() {
  try { fs.unlinkSync(PLAYLIST_STATE_FILE); } catch { /* not there */ }
}

// "track2" before "track10", folders grouped
const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// A playlist folder may carry an order.txt: one file name per line, in the order they should
// play (what `import` writes from the Spotify playlist, and editable by hand). Sequential
// playback follows it; anything not listed plays after, in natural name order.
// playlist-names.json maps a folder name to the name shown to listeners, e.g.
//   { "default": "Starlight Rotation", "halloween": "Halloween Spooktacular" }
// Missing entries fall back to the folder name, tidied up. Re-read when the file changes,
// so renaming a playlist needs no restart.
const PLAYLIST_NAMES_FILE = path.join(__dirname, 'playlist-names.json');
let playlistNamesCache = { mtime: 0, size: -1, map: {} };

function playlistNames() {
  let st;
  try { st = fs.statSync(PLAYLIST_NAMES_FILE); } catch { playlistNamesCache = { mtime: 0, size: -1, map: {} }; return {}; }
  if (st.mtimeMs === playlistNamesCache.mtime && st.size === playlistNamesCache.size) return playlistNamesCache.map;
  let map = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(PLAYLIST_NAMES_FILE, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') map[k.toLowerCase()] = v;
  } catch (e) {
    logWarn(`could not read playlist-names.json: ${e.message}`);
    map = playlistNamesCache.map;
  }
  playlistNamesCache = { mtime: st.mtimeMs, size: st.size, map };
  return map;
}

// "synthwave-80s" -> "Synthwave 80s"
function prettyPlaylistName(name) {
  const custom = playlistNames()[String(name).toLowerCase()];
  if (custom) return custom;
  if (name === 'all') return 'Everything';
  return String(name)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

const ORDER_FILE = 'order.txt';
const orderFileCache = new Map();   // dir -> { mtime, size, names: [normalized] }

function readOrderFile(dir) {
  const file = path.join(dir, ORDER_FILE);
  let st;
  try { st = fs.statSync(file); } catch { orderFileCache.delete(dir); return null; }
  const hit = orderFileCache.get(dir);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.names;
  let names = [];
  try {
    names = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => normalizeName(path.basename(l, path.extname(l))));
  } catch (e) {
    logWarn(`could not read ${path.join(path.basename(dir), ORDER_FILE)}: ${e.message}`);
    return null;
  }
  orderFileCache.set(dir, { mtime: st.mtimeMs, size: st.size, names });
  return names;
}

function parseOrderWord(word) {
  const w = String(word).toLowerCase();
  if (['sequential', 'seq', 'ordered', 'order', 'inorder'].includes(w)) return 'sequential';
  if (['random', 'shuffle', 'shuffled'].includes(w)) return 'random';
  return null;
}

function parsePlaylistSpec(spec) {
  return String(spec || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

class RadioScheduler {
  constructor() {
    this.songPool = [];
    this.playlists = new Map();  // name -> files. Subfolders of songs/ are playlists; loose files are 'default'
    const savedPlaylist = readPlaylistState();
    this.active = parsePlaylistSpec((savedPlaylist && savedPlaylist.active && savedPlaylist.active.join(',')) || CONFIG.playlist);
    this.order = (savedPlaylist && savedPlaylist.order) === 'sequential' ? 'sequential' : (savedPlaylist ? 'random' : CONFIG.playlistOrder);
    this.restoredPlaylist = Boolean(savedPlaylist);
    this.resumeAfter = (savedPlaylist && savedPlaylist.lastSong) || null;   // sequential: where we left off
    this.seqCursor = this.resumeAfter;
    this.genericBumpers = [];
    this.songIntroMap = new Map();
    this.hourlyMap = new Map();  // hour (0-23) -> [files]
    const hourlyState = readHourlyState();
    this.lastHourKey = hourlyState.lastHourKey || null;
    this.lastHourWhy = hourlyState.why || null;
    this.queue = [];
    this.lastSong = null;
    this.songsSinceBumper = 0;
    this.refresh();
    this.rebuildQueue();
  }

  scanPlaylists() {
    const lists = new Map();
    const loose = [];
    for (const entry of fs.readdirSync(CONFIG.songsDir, { withFileTypes: true })) {
      const full = path.join(CONFIG.songsDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        lists.set(entry.name.toLowerCase(), getAudioFilesRecursive(full));
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        loose.push(full);
      }
    }
    if (loose.length || !lists.size) lists.set('default', loose);
    return lists;
  }

  // Files for the active selection. Unknown/empty selection falls back to everything
  // (a live radio should never go silent because of a typo).
  activePool() {
    if (this.active.includes('all')) return [...new Set([...this.playlists.values()].flat())];
    const files = this.active.flatMap(n => this.playlists.get(n) || []);
    if (files.length) return files;
    const missing = this.active.filter(n => !this.playlists.has(n));
    if (missing.length && !this.warnedMissing) {
      logWarn(`playlist(s) not found or empty: ${missing.join(', ')} — playing everything until they exist`);
      this.warnedMissing = true;
    }
    return [...new Set([...this.playlists.values()].flat())];
  }

  // Switch playlists. Returns a message. Takes effect at the next song (see Playout.setPlaylist).
  // Called when a song actually starts playing (not when it is queued), so the resume
  // point reflects what listeners heard rather than what was prefetched.
  noteSongPlaying(file) {
    if (this.order !== 'sequential' || this.resumeAfter === file) return;
    this.resumeAfter = file;
    this.savePlaylistState();
  }

  savePlaylistState() {
    writePlaylistState({ active: this.active, order: this.order, lastSong: this.order === 'sequential' ? this.resumeAfter : null });
  }

  setPlaylist(spec, order = null) {
    const names = parsePlaylistSpec(spec);
    if (!names.length) return 'usage: playlist <name> [sequential|random] [now] | playlist reset';
    this.playlists = this.scanPlaylists();
    const unknown = names.filter(n => n !== 'all' && !this.playlists.has(n));
    if (unknown.length) return `no such playlist: ${unknown.join(', ')} (have: ${[...this.playlists.keys()].join(', ')})`;
    this.active = names;
    if (order) this.order = order;
    this.warnedMissing = false;
    if (this.order === 'sequential') { this.lastSong = null; this.resumeAfter = null; this.seqCursor = null; }   // a fresh switch starts at the top
    this.refresh();
    this.rebuildQueue();
    this.savePlaylistState();
    let first = '';
    if (this.order === 'sequential' && this.queue.length) {
      const ordered = this.orderedCount();
      first = `, starting with ${path.basename(this.queue[0], path.extname(this.queue[0]))}`
        + (ordered ? `; ${ordered}/${this.songPool.length} from ${ORDER_FILE}` : `; no ${ORDER_FILE}, so name order`);
    }
    return `playlist: ${names.join(', ')} (${this.songPool.length} songs, ${this.order}${first})`;
  }

  resetPlaylist() {
    clearPlaylistState();
    this.active = parsePlaylistSpec(CONFIG.playlist);
    this.order = CONFIG.playlistOrder;
    this.restoredPlaylist = false;
    this.warnedMissing = false;
    this.refresh();
    this.rebuildQueue();
    return `playlist: back to the .env default — ${this.active.join(', ')} (${this.songPool.length} songs, ${this.order})`;
  }

  playlistInfo() {
    this.playlists = this.scanPlaylists();
    const available = {};
    for (const [name, files] of this.playlists) available[name] = files.length;
    const names = {};
    for (const name of this.playlists.keys()) names[name] = prettyPlaylistName(name);
    return {
      active: this.active,
      display: this.active.map(prettyPlaylistName).join(' + '),
      order: this.order,
      available,
      names,
    };
  }

  // Rescan the folders. Cheap (a few readdirs), so it runs before every playout block:
  // files dropped in over SFTP are picked up without a restart. New songs are slotted
  // into the current shuffle at random positions; removed songs are dropped from it.
  refresh() {
    ensureDir(CONFIG.songsDir);
    ensureDir(CONFIG.songIntrosDir);
    ensureDir(CONFIG.genericBumpersDir);

    const before = { songs: this.songPool.length, bumpers: this.genericBumpers.length, intros: this.songIntroMap.size };
    const known = new Set(this.songPool);

    this.playlists = this.scanPlaylists();
    this.songPool = this.activePool();
    this.genericBumpers = getAudioFilesRecursive(CONFIG.genericBumpersDir);
    this.songIntroMap = new Map(
      getAudioFilesRecursive(CONFIG.songIntrosDir).map(f => [normalizeName(path.basename(f, path.extname(f))), f])
    );

    this.hourlyMap = new Map();
    for (const f of getAudioFilesRecursive(CONFIG.hourlyIntrosDir)) {
      const h = parseHourName(path.basename(f, path.extname(f)));
      if (h === null) {
        if (!this.warnedHourly) logWarn(`intros/hourly: cannot read an hour from "${path.basename(f)}" — name it 0-23 or 1am..12pm`);
        continue;
      }
      if (!this.hourlyMap.has(h)) this.hourlyMap.set(h, []);
      this.hourlyMap.get(h).push(f);
    }
    this.warnedHourly = true;

    const pool = new Set(this.songPool);
    const added = this.songPool.filter(f => !known.has(f));
    this.queue = this.queue.filter(f => pool.has(f));
    if (this.order === 'sequential') {
      this.queue = this.sequenceFrom(this.seqCursor);    // derived from the cursor; nothing to merge
    } else {
      for (const f of added) this.queue.splice(Math.floor(Math.random() * (this.queue.length + 1)), 0, f);
    }

    const after = { songs: this.songPool.length, bumpers: this.genericBumpers.length, intros: this.songIntroMap.size };
    const diff = Object.keys(after).filter(k => after[k] !== before[k]).map(k => `${k} ${before[k]} -> ${after[k]}`);
    if (diff.length && this.scannedOnce) logInfo(`library changed: ${diff.join(', ')}`);
    this.scannedOnce = true;
  }

  // Sequential play order: a folder's order.txt first (Spotify order from `import`), then
  // anything unlisted in natural name order. Files keep their own folder's ordering.
  sortedPool() {
    const rel = f => path.relative(CONFIG.songsDir, f);
    const rank = new Map();
    for (const f of this.songPool) {
      const names = readOrderFile(path.dirname(f));
      const i = names ? names.indexOf(normalizeName(path.basename(f, path.extname(f)))) : -1;
      rank.set(f, i < 0 ? Infinity : i);
    }
    return [...this.songPool].sort((a, b) => {
      const ra = rank.get(a);
      const rb = rank.get(b);
      if (ra !== rb) return ra - rb;
      return naturalOrder.compare(rel(a), rel(b));
    });
  }

  // How many of the active songs have a place in an order.txt (for status output).
  orderedCount() {
    let n = 0;
    for (const f of this.songPool) {
      const names = readOrderFile(path.dirname(f));
      if (names && names.includes(normalizeName(path.basename(f, path.extname(f))))) n += 1;
    }
    return n;
  }

  rebuildQueue() {
    if (this.order === 'sequential') {
      this.seqCursor = this.seqCursor || this.resumeAfter;
      this.queue = this.sequenceFrom(this.seqCursor);
      return;
    }
    const shuffled = shuffle(this.songPool);
    if (shuffled.length > 1 && this.lastSong && shuffled[0] === this.lastSong) {
      shuffled.push(shuffled.shift());
    }
    this.queue = shuffled;
  }

  // The song after `cursor` in natural order, wrapping at the end. Resolved by name, so a
  // file added or deleted mid-cycle neither skips nor repeats anything.
  nextAfter(cursor) {
    const sorted = this.sortedPool();
    if (!sorted.length) return null;
    if (!cursor) return sorted[0];
    const idx = sorted.indexOf(cursor);
    if (idx >= 0) return sorted[(idx + 1) % sorted.length];
    const rel = f => path.relative(CONFIG.songsDir, f);
    return sorted.find(f => naturalOrder.compare(rel(f), rel(cursor)) > 0) || sorted[0];
  }

  // Sorted pool rotated to continue after `afterFile`; the visible upcoming list.
  sequenceFrom(afterFile) {
    const sorted = this.sortedPool();
    if (!sorted.length || !afterFile) return sorted;
    const rel = f => path.relative(CONFIG.songsDir, f);
    let cut = sorted.indexOf(afterFile);
    if (cut >= 0) {
      cut += 1;
    } else {
      cut = sorted.findIndex(f => naturalOrder.compare(rel(f), rel(afterFile)) > 0);
      if (cut < 0) cut = sorted.length;   // it sorted last: wrap to the top
    }
    return [...sorted.slice(cut), ...sorted.slice(0, cut)];
  }

  findMatchingIntro(songPath) {
    const { artist, title, base } = parseSongInfo(songPath);
    const candidates = [];
    if (artist && title) candidates.push(`${normalizeName(artist)}-${normalizeName(title)}`);
    candidates.push(normalizeName(base));
    if (title) candidates.push(normalizeName(title));
    for (const c of candidates) {
      if (this.songIntroMap.has(c)) return this.songIntroMap.get(c);
    }
    return null;
  }

  getNextSong() {
    this.refresh();
    if (!this.queue.length) this.rebuildQueue();
    let next;
    if (this.order === 'sequential') {
      next = this.nextAfter(this.seqCursor);
      this.seqCursor = next;
      this.queue = this.sequenceFrom(next);   // keep `upcoming` in step
    } else {
      next = this.queue.shift() || null;
    }
    this.lastSong = next;
    return next;
  }

  // Returns [{file, kind}] for the next playout block: [intro|bumper], song
  getNextPlayoutItems() {
    const song = this.getNextSong();
    if (!song) return [];
    return this.playoutItemsFor(song);
  }

  // The hour's clip if one is due at this break, else null. Marks the hour as done.
  takeHourlyIntro() {
    if (!this.hourlyMap.size) return null;
    const now = stationNow();
    if (now.key === this.lastHourKey) return null;          // already done this hour
    const files = this.hourlyMap.get(now.hour);
    if (!files || !files.length) {
      this.markHourDone(now.key, 'no clip for this hour');   // do not retry all hour
      return null;
    }
    if (now.minute > CONFIG.hourlyGraceMinutes) {
      logInfo(`hourly: skipping the ${now.hour}:00 time check (break came ${now.minute} min late)`);
      this.markHourDone(now.key, `skipped, break was ${now.minute} min late`);
      return null;
    }
    this.markHourDone(now.key, 'played');
    return pickRandom(files);
  }

  markHourDone(key, why) {
    this.lastHourKey = key;
    this.lastHourWhy = why;
    writeHourlyState({ lastHourKey: key, why });
  }

  // [intro|bumper], song — for a given song file
  playoutItemsFor(song) {
    const items = [];
    const intro = this.findMatchingIntro(song);
    if (intro) {
      items.push({ file: intro, kind: 'intro' });
    } else if (CONFIG.bumperEvery > 0) {
      this.songsSinceBumper += 1;
      if (this.songsSinceBumper >= CONFIG.bumperEvery) {
        const bumper = pickRandom(this.genericBumpers);
        if (bumper) {
          items.push({ file: bumper, kind: 'bumper' });
          this.songsSinceBumper = 0;
        }
      }
    }
    items.push({ file: song, kind: 'song' });
    return items;
  }

  // Find songs (all playlists) whose file name contains every word of the query.
  findSongs(query) {
    const words = normalizeName(query).split('-').filter(Boolean);
    if (!words.length) return [];
    this.playlists = this.scanPlaylists();
    const all = [...new Set([...this.playlists.values()].flat())];
    const exact = all.filter(f => normalizeName(path.basename(f, path.extname(f))) === words.join('-'));
    if (exact.length) return exact;
    return all.filter(f => { const n = normalizeName(path.basename(f, path.extname(f))); return words.every(w => n.includes(w)); });
  }

  peekUpcoming(n) {
    return this.queue.slice(0, n);
  }
}

// ---------------------------------------------------------------------------
// Track decoding: ffmpeg -> raw PCM queue with read-ahead
// ---------------------------------------------------------------------------

function probe(file) {
  return new Promise(resolve => {
    execFile(CONFIG.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', file], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const fmt = JSON.parse(stdout).format || {};
        const tags = {};
        for (const [k, v] of Object.entries(fmt.tags || {})) tags[k.toLowerCase()] = v;
        resolve({ duration: fmt.duration ? Number(fmt.duration) : null, title: tags.title || '', artist: tags.artist || '' });
      } catch {
        resolve(null);
      }
    });
  });
}

class TrackSource {
  constructor(file, kind) {
    this.file = file;
    this.kind = kind; // 'song' | 'intro' | 'bumper'
    const parsed = parseSongInfo(file);
    this.title = parsed.title;
    this.artist = parsed.artist;
    this.duration = null;

    this.chunks = [];
    this.length = 0;
    this.done = false;
    this.paused = false;
    this.position = 0; // bytes handed to the timeline
    this.startedAt = null;
    this.proc = null;
    this.stderr = '';

    this.gainDb = 0;
    this.startRequested = false;
    this.destroyed = false;
    this.ready = Promise.all([
      probe(file).then(meta => {
        if (!meta) return;
        if (meta.duration) this.duration = meta.duration;
        // Bumpers keep their file names; songs prefer embedded tags.
        if (kind === 'song') {
          if (meta.title) this.title = meta.title;
          if (meta.artist) this.artist = meta.artist;
        }
      }),
      CONFIG.normalize ? measureLoudness(file).then(m => { this.loudness = m; this.gainDb = loudnessGainDb(m, kind); }) : Promise.resolve(),
    ]);
  }

  get displayTitle() {
    return this.artist ? `${this.artist} - ${this.title}` : this.title;
  }

  // Decoding starts once probe + loudness measurement are done (cached: instant; first
  // time: a few seconds, which the prefetch lead absorbs).
  start(offsetSeconds = 0) {
    if (this.startRequested) return this;
    this.startRequested = true;
    this.ready.then(() => { if (!this.destroyed) this.spawn(offsetSeconds); });
    return this;
  }

  spawn(offsetSeconds = 0) {
    const filters = [];
    if (CONFIG.normalize && this.gainDb !== 0) filters.push(`volume=${this.gainDb.toFixed(2)}dB`);
    if (CONFIG.volume !== 1) filters.push(`volume=${CONFIG.volume}`);

    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      ...(offsetSeconds > 0 ? ['-ss', offsetSeconds.toFixed(3)] : []),
      '-i', this.file,
      '-vn', '-map', '0:a:0',
      ...(filters.length ? ['-af', filters.join(',')] : []),
      '-f', 's16le', '-ar', String(CONFIG.sampleRate), '-ac', String(CONFIG.channels),
      'pipe:1',
    ];

    const proc = spawn(CONFIG.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.stderr = '';

    // Every handler checks it still belongs to the active decoder: seek() replaces it.
    proc.stdout.on('data', chunk => {
      if (this.proc !== proc) return;
      this.chunks.push(chunk);
      this.length += chunk.length;
      if (!this.paused && this.length >= DECODER_HIGH_WATER) {
        this.paused = true;
        proc.stdout.pause();
      }
    });
    proc.stdout.on('end', () => { if (this.proc === proc) this.done = true; });
    proc.stderr.on('data', d => { this.stderr += d.toString(); });
    proc.on('error', err => {
      if (this.proc !== proc) return;
      logErr(`decoder spawn error for ${path.basename(this.file)}: ${err.message}`);
      this.done = true;
    });
    proc.on('close', code => {
      if (this.proc !== proc) return;
      this.done = true;
      if (code && code !== 0 && this.stderr.trim()) {
        logWarn(`decoder exited ${code} for ${path.basename(this.file)}: ${this.stderr.trim().split('\n').pop()}`);
      }
    });
    return this;
  }

  // Jump to an absolute position (seconds) by restarting the decoder there.
  seek(seconds) {
    const target = Math.max(0, seconds);
    if (this.duration && target >= this.duration - 0.5) return false; // past the end: caller should skip
    const old = this.proc;
    if (old && old.exitCode === null) {
      try { old.kill(); } catch { /* ignore */ }
    }
    this.chunks = [];
    this.length = 0;
    this.done = false;
    this.paused = false;
    this.position = Math.round((target * PCM_BPS) / PCM_FRAME) * PCM_FRAME;
    this.spawn(target);
    return true;
  }

  get finished() {
    return this.done && this.length === 0;
  }

  // Read up to n bytes (kept aligned to whole sample frames). null if nothing buffered.
  read(n) {
    if (this.length === 0) return null;
    n = Math.min(n, this.length);
    if (!this.done) n -= n % PCM_FRAME;
    if (n <= 0) return null;

    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - off);
      head.copy(out, off, 0, take);
      off += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.length -= n;
    this.position += n;

    if (this.paused && this.length < DECODER_LOW_WATER && this.proc) {
      this.paused = false;
      this.proc.stdout.resume();
    }
    return out;
  }

  destroy() {
    this.destroyed = true;
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this.chunks = [];
    this.length = 0;
    this.done = true;
  }

  toJSON() {
    return {
      kind: this.kind,
      title: this.title,
      artist: this.artist,
      display: this.displayTitle,
      file: path.basename(this.file),
      duration: this.duration,
      gainDb: Math.round(this.gainDb * 10) / 10,
      loudness: this.loudness ? { lufs: this.loudness.i, truePeak: this.loudness.tp } : null,
      position: this.startedAt ? this.position / PCM_BPS : 0,
      startedAt: this.startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Encoder: PCM stdin -> MP3 stdout (+ optional HLS)
// ---------------------------------------------------------------------------

class Encoder extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.running = false;
    this.restarts = 0;
  }

  start() {
    this.running = true;
    this.spawn();
  }

  spawn() {
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'warning',
      '-f', 's16le', '-ar', String(CONFIG.sampleRate), '-ac', String(CONFIG.channels),
      '-channel_layout', CONFIG.channels === 1 ? 'mono' : 'stereo', '-i', 'pipe:0',
      // MP3 live output
      '-map', '0:a', '-c:a', 'libmp3lame', '-b:a', `${CONFIG.bitrate}k`,
      '-ar', String(CONFIG.sampleRate), '-ac', String(CONFIG.channels),
      '-write_xing', '0', '-id3v2_version', '0', '-map_metadata', '-1',
      '-flush_packets', '1', '-f', 'mp3', 'pipe:1',
    ];

    if (CONFIG.hls) {
      ensureDir(CONFIG.hlsDir);
      args.push(
        '-map', '0:a', '-c:a', 'aac', '-b:a', `${CONFIG.hlsBitrate}k`,
        '-f', 'hls',
        '-hls_time', String(CONFIG.hlsSegmentSeconds),
        '-hls_list_size', String(CONFIG.hlsWindowSegments),
        '-hls_delete_threshold', String(CONFIG.hlsKeepSegments),
        '-hls_flags', 'delete_segments+omit_endlist+independent_segments+program_date_time',
        '-hls_segment_type', 'mpegts',
        '-start_number', String(Math.floor(Date.now() / 1000)),
        '-hls_segment_filename', path.join(CONFIG.hlsDir, 'seg_%d.ts'),
        path.join(CONFIG.hlsDir, 'live.m3u8'),
      );
    }

    const proc = spawn(CONFIG.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;

    proc.stdout.on('data', chunk => this.emit('data', chunk));
    proc.stderr.on('data', d => {
      const text = d.toString().trim();
      if (text) logWarn(`[encoder] ${text}`);
    });
    proc.stdin.on('error', err => {
      if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') logErr(`encoder stdin: ${err.message}`);
    });
    proc.on('error', err => {
      logErr(`encoder spawn error: ${err.message} (set FFMPEG_PATH or put ffmpeg on PATH)`);
    });
    proc.on('close', code => {
      if (this.proc === proc) this.proc = null;
      if (!this.running) return;
      this.restarts += 1;
      logWarn(`encoder exited (${code}); restarting in 1s`);
      setTimeout(() => { if (this.running && !this.proc) this.spawn(); }, 1000);
    });
  }

  write(buf) {
    const p = this.proc;
    if (p && p.stdin.writable && !p.stdin.destroyed) p.stdin.write(buf);
  }

  stop() {
    this.running = false;
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* ignore */ }
      try { this.proc.kill(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Playout: the single shared playhead
// ---------------------------------------------------------------------------

class Playout extends EventEmitter {
  constructor(scheduler, encoder) {
    super();
    this.scheduler = scheduler;
    this.encoder = encoder;
    this.pending = [];       // prepared TrackSources (decoding ahead)
    this.current = null;
    this.history = [];
    this.clockStart = 0;
    this.bytesSent = 0;
    this.underruns = 0;
    this.stalls = 0;
    this.timer = null;
    this.startedAt = new Date();
  }

  fill() {
    while (this.pending.length < 2) {
      const items = this.scheduler.getNextPlayoutItems();
      if (!items.length) break;
      for (const item of items) this.pending.push(new TrackSource(item.file, item.kind));
    }
    // Only ever decode the head of the queue ahead of time (one prefetch).
    const next = this.pending[0];
    if (next && !next.startRequested) next.start();
  }

  advance() {
    const endedKind = this.current ? this.current.kind : null;
    if (this.current) {
      this.current.destroy();
      this.history.unshift({ ...this.current.toJSON(), endedAt: new Date().toISOString() });
      this.history.length = Math.min(this.history.length, 50);
    }
    this.fill();

    // Top-of-hour time check. Decided here, at the break itself, so the clip reflects the
    // time it actually airs. Only between blocks (a song just ended, or we are starting up),
    // so a song running past the hour is never interrupted — it just delays the check.
    if (endedKind === null || endedKind === 'song') {
      // A queued clip takes this break; otherwise the real top-of-hour check.
      const forced = this.forcedBreak;
      this.forcedBreak = null;
      const hourly = forced ? null : this.scheduler.takeHourlyIntro();
      const item = forced || (hourly ? { file: hourly, kind: 'hourly' } : null);
      if (item) {
        const head = this.pending[0];
        if (head && (head.kind === 'bumper' || head.kind === 'intro')) {
          head.destroy();            // this break's bumper is replaced
          this.pending.shift();
        }
        this.scheduler.songsSinceBumper = 0;
        this.pending.unshift(new TrackSource(item.file, item.kind).start());
      }
    }

    this.current = this.pending.shift() || null;
    if (this.current) {
      if (!this.current.startRequested) this.current.start();
      this.current.startedAt = new Date().toISOString();
      this.fill(); // kick decoding for the following item
      const cur = this.current;
      if (cur.kind === 'song') this.scheduler.noteSongPlaying(cur.file);
      cur.ready.then(() => logInfo(`${COLORS.magenta}▶ ${cur.kind}${COLORS.reset} ${cur.displayTitle}${CONFIG.normalize && cur.loudness ? ` (${cur.loudness.i.toFixed(1)} LUFS, gain ${cur.gainDb >= 0 ? '+' : ''}${cur.gainDb.toFixed(1)} dB)` : ''}`));
      this.emit('track', this.current);
    } else if (Date.now() - (this.lastEmptyWarn || 0) > 30000) {
      this.lastEmptyWarn = Date.now();
      logWarn('library empty — streaming silence until songs appear');
    }
  }

  async start() {
    this.fill();
    // Wait (briefly) for the first decoder to have audio so we don't open with silence.
    const first = this.pending[0];
    if (first) {
      const deadline = Date.now() + 5000;
      while (first.length === 0 && !first.done && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
      }
    }
    this.clockStart = performance.now();
    this.bytesSent = 0;
    this.tick();
  }

  tick() {
    const elapsed = (performance.now() - this.clockStart) / 1000;
    const target = Math.floor((elapsed * PCM_BPS) / PCM_FRAME) * PCM_FRAME;
    let need = target - this.bytesSent;

    if (need > MAX_CATCHUP_BYTES) {
      // The process was suspended (laptop sleep, debugger...). Drop the lost time.
      this.stalls += 1;
      this.bytesSent = target - TICK_BYTES;
      need = TICK_BYTES;
    }

    const out = [];
    let guard = 0;
    while (need > 0 && guard++ < 16) {
      if (!this.current) this.advance();
      if (!this.current) {
        out.push(Buffer.alloc(need));
        need = 0;
        break;
      }
      const chunk = this.current.read(need);
      if (chunk) {
        out.push(chunk);
        need -= chunk.length;
      } else if (this.current.finished) {
        this.advance();
      } else {
        // Decoder slower than real time: keep the clock honest with silence.
        this.underruns += 1;
        out.push(Buffer.alloc(need));
        need = 0;
      }
    }

    if (out.length) {
      const buf = out.length === 1 ? out[0] : Buffer.concat(out);
      this.bytesSent += buf.length;
      this.encoder.write(buf);
    }

    this.timer = setTimeout(() => this.tick(), TICK_MS);
  }

  skip() {
    if (!this.current) return false;
    logInfo(`skip requested: ${this.current.displayTitle}`);
    this.advance();
    return true;
  }

  // spec: "+30" / "-10" (relative seconds), "90" or "1:30" (absolute). Returns a message.
  // Test helper: play an hour's time check at the next break without consuming the
  // once-per-hour state, so a real check still fires when the hour turns.
  forceHourly(hourArg) {
    this.scheduler.refresh();
    const map = this.scheduler.hourlyMap;
    if (!map.size) return 'no time checks installed';
    const hour = hourArg === '' ? stationNow().hour : parseHourName(hourArg);
    if (hour === null) return `cannot read an hour from "${hourArg}" — use 0-23 or 1am..12pm`;
    const files = map.get(hour);
    if (!files || !files.length) return `no clip for hour ${hour} (have: ${[...map.keys()].sort((a, b) => a - b).join(' ')})`;
    const file = pickRandom(files);
    this.forcedBreak = { file, kind: 'hourly' };
    return `queued: hour ${hour} (${path.basename(file)}) plays at the next break, i.e. when the current song ends (skip past any bumper first)`;
  }

  // Queue a specific generic bumper (or a random one) for the next break.
  queueBumper(query) {
    this.scheduler.refresh();
    const pool = this.scheduler.genericBumpers;
    if (!pool.length) return 'no bumpers installed';
    let file;
    if (!query) {
      file = pickRandom(pool);
    } else {
      const words = normalizeName(query).split('-').filter(Boolean);
      const named = f => normalizeName(path.basename(f, path.extname(f)));
      const exact = pool.filter(f => named(f) === words.join('-'));
      const matches = exact.length ? exact : pool.filter(f => words.every(w => named(f).includes(w)));
      if (!matches.length) return `no bumper matches "${query}"`;
      if (matches.length > 1) {
        return `${matches.length} bumpers match "${query}" — be more specific:${String.fromCharCode(10)}${matches.slice(0, 10).map(f => path.basename(f)).join(String.fromCharCode(10))}${matches.length > 10 ? `${String.fromCharCode(10)}…` : ''}`;
      }
      file = matches[0];
    }
    this.forcedBreak = { file, kind: 'bumper' };
    return `queued: ${path.basename(file)} plays at the next break (when the current song ends)`;
  }

  // Queue a specific song next (with its intro/bumper), or cut to it now.
  request(query, now = false) {
    const matches = this.scheduler.findSongs(query);
    if (!matches.length) return `no song matches "${query}"`;
    if (matches.length > 1) {
      const names = matches.slice(0, 8).map(f => path.basename(f, path.extname(f)));
      return `${matches.length} songs match "${query}" — be more specific:${String.fromCharCode(10)}${names.join(String.fromCharCode(10))}${matches.length > 8 ? `${String.fromCharCode(10)}…` : ''}`;
    }
    const song = matches[0];
    this.scheduler.queue = this.scheduler.queue.filter(f => f !== song); // don't repeat it soon after
    const items = this.scheduler.playoutItemsFor(song).map(item => new TrackSource(item.file, item.kind));
    this.pending.unshift(...items);
    this.fill(); // start decoding the new head
    const name = path.basename(song, path.extname(song));
    if (now) {
      logInfo(`request: ${name} (now)`);
      this.advance();
      return `playing now: ${name}`;
    }
    logInfo(`request: ${name} (next)`);
    return `up next: ${name}`;
  }

  seek(spec) {
    const cur = this.current;
    if (!cur) return 'nothing playing';
    const s = String(spec).trim();
    const m = /^([+-])?(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(s);
    if (!m) return 'usage: seek +30 | seek -10 | seek 90 | seek 1:30';
    const secs = (m[2] ? Number(m[2]) * 60 : 0) + Number(m[3]);
    const nowPos = cur.position / PCM_BPS;
    const target = m[1] === '+' ? nowPos + secs : m[1] === '-' ? nowPos - secs : secs;

    if (!cur.seek(target)) {
      logInfo(`seek past end of ${cur.displayTitle}; skipping`);
      this.advance();
      return 'past end, skipped';
    }
    logInfo(`seek ${cur.displayTitle}: ${nowPos.toFixed(1)}s -> ${Math.max(0, target).toFixed(1)}s`);
    return `seeked to ${Math.max(0, target).toFixed(1)}s`;
  }

  reload() {
    this.scheduler.refresh();
    this.scheduler.rebuildQueue();
    for (const t of this.pending) t.destroy();
    this.pending = [];
    this.fill();
    logInfo(`library reloaded: ${this.scheduler.songPool.length} songs, ${this.scheduler.genericBumpers.length} bumpers, ${this.scheduler.songIntroMap.size} song intros`);
  }

  // Switch playlist. Queued items from the old playlist are dropped; the current song
  // finishes unless `now` is set.
  setPlaylist(spec, { now = false, order = null, reset = false } = {}) {
    const msg = reset ? this.scheduler.resetPlaylist() : this.scheduler.setPlaylist(spec, order);
    if (!msg.startsWith('playlist:')) return msg;
    for (const t of this.pending) t.destroy();
    this.pending = [];
    this.fill();
    logInfo(`${msg}${now ? ' (switching now)' : ' (after the current track)'}`);
    if (now) this.advance();
    return msg;
  }

  stop() {
    clearTimeout(this.timer);
    if (this.current) this.current.destroy();
    for (const t of this.pending) t.destroy();
  }

  // Metadata string pushed to ICY clients
  streamTitle() {
    const cur = this.current;
    if (!cur) return CONFIG.name;
    if (cur.kind === 'song') return cur.displayTitle;
    const next = this.pending.find(t => t.kind === 'song');
    return next ? `${CONFIG.name} — up next: ${next.displayTitle}` : CONFIG.name;
  }

  // What a listener who is `delay` seconds behind the playhead is hearing right now,
  // reconstructed from the current track and the history. Returns null if unknown.
  playingAgo(delay) {
    if (!(delay > 0)) return this.current ? this.current.toJSON() : null;
    const cur = this.current;
    if (cur) {
      const pos = cur.position / PCM_BPS;
      if (pos >= delay) return { ...cur.toJSON(), position: pos - delay };
    }
    const target = Date.now() - delay * 1000;
    for (const h of this.history) {
      const endedMs = Date.parse(h.endedAt);
      const startedMs = endedMs - (h.position || 0) * 1000;
      if (target >= startedMs && target < endedMs) {
        return { ...h, position: (target - startedMs) / 1000 };
      }
    }
    return cur ? cur.toJSON() : null;   // history does not reach back that far
  }

  // The track after the one a delayed listener is hearing.
  // The next *song* after what the delayed listener is hearing — bumpers, intros and time
  // checks are skipped, so a UI never shows "up next: bumper14".
  nextAfterAgo(delay, nowItem) {
    const fromPending = () => {
      const nextSong = this.pending.find(t => t.kind === 'song');
      return nextSong ? { kind: nextSong.kind, display: nextSong.displayTitle, file: path.basename(nextSong.file) } : null;
    };
    if (!(delay > 0) || !nowItem) return fromPending();

    // history is newest-first, so items that come *after* nowItem are at lower indices.
    const idx = this.history.findIndex(h => h.file === nowItem.file && h.endedAt === nowItem.endedAt);
    if (idx >= 0) {
      for (let i = idx - 1; i >= 0; i -= 1) {
        const h = this.history[i];
        if (h.kind === 'song') return { kind: h.kind, display: h.display, file: h.file };
      }
    }
    if (this.current && this.current.kind === 'song' && (idx >= 0 || !nowItem.endedAt)) {
      if (path.basename(this.current.file) !== nowItem.file) {
        return { kind: this.current.kind, display: this.current.displayTitle, file: path.basename(this.current.file) };
      }
    }
    return fromPending();
  }

  // Seconds an HLS listener trails the playhead (playlist window + one segment of buffer).
  hlsDelaySeconds() {
    return CONFIG.hls ? CONFIG.hlsWindowSegments * CONFIG.hlsSegmentSeconds : 0;
  }

  status(delay = 0) {
    const nextSong = this.pending.find(t => t.kind === 'song');
    if (delay > 0) {
      const nowItem = this.playingAgo(delay);
      return {
        station: { name: CONFIG.name, description: CONFIG.description, genre: CONFIG.genre },
        live: true,
        delay,
        now: nowItem,
        next: this.nextAfterAgo(delay, nowItem),
        playlist: this.scheduler.playlistInfo(),
        upcoming: [
          ...(this.current && (!nowItem || nowItem.file !== path.basename(this.current.file)) ? [this.current.displayTitle] : []),
          ...this.pending.filter(t => t.kind === 'song').map(t => t.displayTitle),
        ].slice(0, 5),
        serverTime: new Date().toISOString(),
        uptime: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
        underruns: this.underruns,
        stalls: this.stalls,
      };
    }
    return {
      station: { name: CONFIG.name, description: CONFIG.description, genre: CONFIG.genre },
      live: true,
      now: this.current ? this.current.toJSON() : null,
      next: nextSong ? { kind: nextSong.kind, display: nextSong.displayTitle, file: path.basename(nextSong.file) } : null,
      playlist: this.scheduler.playlistInfo(),
      upcoming: [
        ...this.pending.filter(t => t.kind === 'song').map(t => t.displayTitle),
        ...this.scheduler.peekUpcoming(5).map(f => parseSongInfo(f)).map(p => (p.artist ? `${p.artist} - ${p.title}` : p.title)),
      ].slice(0, 5),
      serverTime: new Date().toISOString(),
      uptime: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      underruns: this.underruns,
      stalls: this.stalls,
    };
  }
}

// ---------------------------------------------------------------------------
// MP3 frame parser (so the burst buffer and every write are frame-aligned)
// ---------------------------------------------------------------------------

const MP3_BITRATES = {
  1: { // MPEG-1
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: { // MPEG-2 / 2.5
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
const MP3_SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

function parseMp3Header(buf, i) {
  if (i + 4 > buf.length) return null;
  const b1 = buf[i], b2 = buf[i + 1], b3 = buf[i + 2];
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;
  const versionBits = (b2 >> 3) & 3;
  if (versionBits === 1) return null;
  const layerBits = (b2 >> 1) & 3;
  if (layerBits === 0) return null;
  const bitrateIdx = (b3 >> 4) & 15;
  if (bitrateIdx === 0 || bitrateIdx === 15) return null;
  const srIdx = (b3 >> 2) & 3;
  if (srIdx === 3) return null;
  const padding = (b3 >> 1) & 1;

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer = 4 - layerBits;
  const sr = MP3_SAMPLE_RATES[version][srIdx];
  const br = MP3_BITRATES[version === 1 ? 1 : 2][layer][bitrateIdx] * 1000;

  let length, samples;
  if (layer === 1) {
    length = (Math.floor((12 * br) / sr) + padding) * 4;
    samples = 384;
  } else if (layer === 2) {
    length = Math.floor((144 * br) / sr) + padding;
    samples = 1152;
  } else {
    length = Math.floor(((version === 1 ? 144 : 72) * br) / sr) + padding;
    samples = version === 1 ? 1152 : 576;
  }
  return { length, seconds: samples / sr };
}

class Mp3FrameParser {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  // Returns { buf, seconds } of complete, validated frames extracted from the stream.
  push(chunk) {
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let i = 0;
    let end = 0;
    let seconds = 0;

    while (i + 4 <= buf.length) {
      const hdr = parseMp3Header(buf, i);
      if (!hdr) { i += 1; continue; }
      if (i + hdr.length + 4 > buf.length) break; // wait for the next header to validate against
      if (!parseMp3Header(buf, i + hdr.length)) { i += 1; continue; } // false sync
      if (i !== end) {
        // Skip junk between frames (should not happen with a clean encoder stream).
        buf = Buffer.concat([buf.subarray(0, end), buf.subarray(i)]);
        i = end;
      }
      i += hdr.length;
      end = i;
      seconds += hdr.seconds;
    }

    const out = buf.subarray(0, end);
    this.pending = Buffer.from(buf.subarray(end));
    return end ? { buf: Buffer.from(out), seconds } : null;
  }
}

// ---------------------------------------------------------------------------
// Broadcaster: burst buffer + connected listeners (+ ICY metadata)
// ---------------------------------------------------------------------------

class Listener {
  constructor(res, metaInt, getTitle) {
    this.res = res;
    this.metaInt = metaInt;
    this.untilMeta = metaInt;
    this.getTitle = getTitle;
    this.lastTitle = null;
    this.connectedAt = Date.now();
    this.remote = res.socket ? res.socket.remoteAddress : '?';
  }

  metaBlock() {
    const title = this.getTitle();
    if (title === this.lastTitle) return Buffer.from([0]);
    this.lastTitle = title;
    const safe = title.replace(/'/g, '’').slice(0, 200);
    const text = Buffer.from(`StreamTitle='${safe}';`, 'utf8');
    const blocks = Math.min(255, Math.ceil(text.length / 16));
    const out = Buffer.alloc(1 + blocks * 16);
    out[0] = blocks;
    text.copy(out, 1, 0, Math.min(text.length, blocks * 16));
    return out;
  }

  send(buf) {
    if (this.res.writableLength > CONFIG.maxClientBacklog) return false;
    if (!this.metaInt) {
      this.res.write(buf);
      return true;
    }
    const parts = [];
    let off = 0;
    while (off < buf.length) {
      const take = Math.min(this.untilMeta, buf.length - off);
      parts.push(buf.subarray(off, off + take));
      off += take;
      this.untilMeta -= take;
      if (this.untilMeta === 0) {
        parts.push(this.metaBlock());
        this.untilMeta = this.metaInt;
      }
    }
    this.res.write(parts.length === 1 ? parts[0] : Buffer.concat(parts));
    return true;
  }
}

class Broadcaster {
  constructor(playout) {
    this.playout = playout;
    this.listeners = new Set();
    this.ring = [];
    this.ringSeconds = 0;
    this.parser = new Mp3FrameParser();
    this.bytesOut = 0;
    this.peakListeners = 0;
  }

  onEncoded(chunk) {
    const frames = this.parser.push(chunk);
    if (!frames) return;

    this.ring.push(frames);
    this.ringSeconds += frames.seconds;
    while (this.ring.length > 1 && this.ringSeconds - this.ring[0].seconds >= CONFIG.burstSeconds) {
      this.ringSeconds -= this.ring.shift().seconds;
    }

    for (const l of this.listeners) {
      if (!l.send(frames.buf)) this.drop(l, 'slow client');
    }
    this.bytesOut += frames.buf.length * this.listeners.size;
  }

  add(res, wantsMeta) {
    const l = new Listener(res, wantsMeta ? CONFIG.icyMetaInt : 0, () => this.playout.streamTitle());
    this.listeners.add(l);
    this.peakListeners = Math.max(this.peakListeners, this.listeners.size);
    res.on('close', () => this.listeners.delete(l));
    res.on('error', () => this.listeners.delete(l));

    // Pre-roll: the last few seconds, so players start decoding immediately.
    if (this.ring.length) l.send(Buffer.concat(this.ring.map(r => r.buf)));
    return l;
  }

  drop(l, reason) {
    this.listeners.delete(l);
    logWarn(`dropping listener ${l.remote}: ${reason}`);
    try { l.res.destroy(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Loudness: measured once per file (EBU R128 integrated loudness + true peak),
// cached in loudness-cache.json, applied as ONE fixed gain for the whole track
// (ReplayGain-style). No dynamic processing, so quiet and loud passages keep
// their relationship; only the overall level of each track is aligned.
// ---------------------------------------------------------------------------

const LOUDNESS_CACHE_FILE = path.join(__dirname, 'loudness-cache.json');
let loudnessCache = null;
let loudnessSaveTimer = null;

function loadLoudnessCache() {
  if (loudnessCache) return loudnessCache;
  try { loudnessCache = JSON.parse(fs.readFileSync(LOUDNESS_CACHE_FILE, 'utf8')); } catch { loudnessCache = {}; }
  return loudnessCache;
}

function saveLoudnessCacheSoon() {
  clearTimeout(loudnessSaveTimer);
  loudnessSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(LOUDNESS_CACHE_FILE, JSON.stringify(loudnessCache)); } catch (e) { logWarn(`could not save loudness cache: ${e.message}`); }
  }, 2000);
  loudnessSaveTimer.unref();
}

// Returns { i, tp } in LUFS / dBTP, or null if it cannot be measured.
function measureLoudness(file) {
  const cache = loadLoudnessCache();
  let st;
  try { st = fs.statSync(file); } catch { return Promise.resolve(null); }
  const key = path.resolve(file);
  const hit = cache[key];
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return Promise.resolve(hit);

  return new Promise(resolve => {
    const [cmd, ...rest] = backgroundFfmpeg(['-i', file, '-vn', '-map', '0:a:0', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
    execFile(cmd, rest, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr || '');
      if (err || !m) {
        logWarn(`loudness measurement failed for ${path.basename(file)}: ${(stderr || (err && err.message) || '').trim().split(String.fromCharCode(10)).pop()}`);
        return resolve(null);
      }
      try {
        const j = JSON.parse(m[0]);
        const i = Number(j.input_i), tp = Number(j.input_tp);
        if (!Number.isFinite(i) || !Number.isFinite(tp)) return resolve(null);
        const entry = { i, tp, size: st.size, mtime: st.mtimeMs };
        cache[key] = entry;
        saveLoudnessCacheSoon();
        resolve(entry);
      } catch {
        resolve(null);
      }
    });
  });
}

// Gain (dB) that brings the track to the target loudness without letting its true
// peak exceed the ceiling. Silent/unmeasurable tracks get 0.
function loudnessGainDb(m, kind = 'song') {
  if (!m || m.i < -70) return 0;
  const target = CONFIG.normalizeTarget + (kind === 'song' ? 0 : CONFIG.bumperOffsetDb);
  const wanted = target - m.i;
  const headroom = CONFIG.normalizePeak - m.tp;
  return Math.max(-30, Math.min(wanted, headroom, 30));
}

// ---------------------------------------------------------------------------
// Raw bumper processing: intros/raw/*  ->  intros/generic/*.mp3
//   1. "radio" effect = Audacity Echo (delay 10 ms, decay 0.5), a feedback comb
//      filter, reproduced as 12 aecho taps (0.5^12 = -72 dB, inaudible remainder)
//   2. peak-normalise to PROCESS_PEAK_DB
// Files are picked up once their size has been stable for a couple of scans, so a
// half-finished SFTP upload is never processed. Originals move to intros/raw/done/.
// ---------------------------------------------------------------------------

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

// The broadcast chain, in the order a station would run it:
//   high-pass -> downward expander -> de-esser -> presence EQ -> echo -> compressor -> limiter
// The echo sits after the expander (so its tails are not ducked as noise) and before the
// dynamics (so the compressor evens it out and the limiter guarantees the ceiling).
function voiceChainFilters({ echo = true, chain = true } = {}) {
  const f = [];
  if (chain && CONFIG.voiceChain) {
    if (CONFIG.voiceHpfHz > 0) f.push(`highpass=f=${CONFIG.voiceHpfHz}:poles=2`);
    if (CONFIG.voiceExpander) {
      f.push([
        'agate=mode=downward',
        `threshold=${clampLinear(dbToLinear(CONFIG.voiceExpThresholdDb), 0, 1)}`,
        `ratio=${CONFIG.voiceExpRatio}`,
        `range=${clampLinear(dbToLinear(CONFIG.voiceExpRangeDb), 0, 1)}`,
        `attack=${CONFIG.voiceExpAttackMs}`,
        `release=${CONFIG.voiceExpReleaseMs}`,
        'knee=4:detection=rms',
      ].join(':'));
    }
    if (CONFIG.voiceDeess) {
      f.push(`deesser=i=${CONFIG.voiceDeessIntensity}:m=${CONFIG.voiceDeessMax}:f=${CONFIG.voiceDeessFreq}:s=o`);
    }
    if (CONFIG.voiceEq && CONFIG.voiceEqGainDb !== 0) {
      f.push(`equalizer=f=${CONFIG.voiceEqHz}:t=q:w=${CONFIG.voiceEqQ}:g=${CONFIG.voiceEqGainDb}`);
    }
  }
  if (echo) f.push(echoFilter());
  if (chain && CONFIG.voiceChain) {
    if (CONFIG.voiceComp) {
      f.push([
        'acompressor=mode=downward',
        `threshold=${clampLinear(dbToLinear(CONFIG.voiceCompThresholdDb), 0.000976563, 1)}`,
        `ratio=${CONFIG.voiceCompRatio}`,
        `attack=${CONFIG.voiceCompAttackMs}`,
        `release=${CONFIG.voiceCompReleaseMs}`,
        `makeup=${clampLinear(dbToLinear(CONFIG.voiceCompMakeupDb), 1, 64)}`,
        'knee=4:detection=rms',
      ].join(':'));
    }
    if (CONFIG.voiceLimit) {
      // level=disabled, or alimiter normalises back to full scale and undoes our levelling.
      f.push(`alimiter=limit=${clampLinear(dbToLinear(CONFIG.voiceLimitCeilingDb), 0.0625, 1)}:attack=5:release=50:level=disabled:latency=1`);
    }
  }
  return f;
}

// Short human summary of the active stages, for the log and the `fx` command.
function describeVoiceChain() {
  const on = [];
  if (CONFIG.voiceChain) {
    if (CONFIG.voiceHpfHz > 0) on.push(`hpf ${CONFIG.voiceHpfHz}Hz`);
    if (CONFIG.voiceExpander) on.push(`expander ${CONFIG.voiceExpThresholdDb}dB`);
    if (CONFIG.voiceDeess) on.push(`de-ess ${CONFIG.voiceDeessIntensity}`);
    if (CONFIG.voiceEq && CONFIG.voiceEqGainDb !== 0) on.push(`eq ${CONFIG.voiceEqGainDb >= 0 ? '+' : ''}${CONFIG.voiceEqGainDb}dB@${CONFIG.voiceEqHz}`);
  }
  on.push(`echo ${CONFIG.processEchoDelayMs}ms/${CONFIG.processEchoDecay}`);
  if (CONFIG.voiceChain) {
    if (CONFIG.voiceComp) on.push(`comp ${CONFIG.voiceCompRatio}:1@${CONFIG.voiceCompThresholdDb}dB`);
    if (CONFIG.voiceLimit) on.push(`limit ${CONFIG.voiceLimitCeilingDb}dB`);
  }
  return on.join(' > ');
}

function clampLinear(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v)).toFixed(6);
}

function echoFilter() {
  const taps = 12;
  const delays = [], decays = [];
  for (let i = 1; i <= taps; i += 1) {
    delays.push((CONFIG.processEchoDelayMs * i).toFixed(3));
    decays.push(Math.pow(CONFIG.processEchoDecay, i).toFixed(6));
  }
  return `aecho=1:1:${delays.join('|')}:${decays.join('|')}`;
}

// Background ffmpeg jobs (processing, check) must never starve the live encoder:
// on Linux run them under nice(19) and on a single thread.
function backgroundFfmpeg(args) {
  const ff = [CONFIG.ffmpeg, '-nostdin', '-hide_banner', '-threads', '1', ...args];
  return process.platform === 'win32' ? ff : ['nice', '-n', '19', ...ff];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = backgroundFfmpeg(['-y', ...args]);
    execFile(cmd, rest, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split(/\r?\n/).pop()));
      else resolve(stderr);
    });
  });
}

async function processRawFile(src, { echo = true, destDir = CONFIG.genericBumpersDir } = {}) {
  const base = path.basename(src, path.extname(src));
  ensureDir(destDir);
  const dest = path.join(destDir, `${base}.mp3`);
  const tmp = path.join(CONFIG.rawIntrosDir, `.${base}.tmp.mp3`);

  // The expander and compressor thresholds are absolute, so a quiet take would slip under
  // them and a hot one would be crushed. Level the take first and the chain behaves the
  // same whatever the recording level was.
  let preGainDb = 0;
  if (echo && CONFIG.voiceChain) {
    const lufs = await measureInputLufs(src);
    if (lufs !== null && lufs > -70) {
      preGainDb = Math.max(-24, Math.min(24, CONFIG.voiceInputTargetLufs - lufs));
    }
  }

  // `clean` sources (intros/raw/*/clean) stay untouched apart from the gain.
  const chain = voiceChainFilters({ echo, chain: echo });
  if (preGainDb !== 0) chain.unshift(`volume=${preGainDb.toFixed(2)}dB`);

  // pass 1: measure the peak after the effect
  const report = await runFfmpeg(['-i', src, '-vn', '-af', [...chain, 'volumedetect'].join(','), '-f', 'null', '-']);
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(report);
  const gainDb = m ? CONFIG.processPeakDb - Number(m[1]) : 0;

  // pass 2: effect + gain -> mp3
  chain.push(`volume=${gainDb.toFixed(2)}dB`);
  await runFfmpeg(['-i', src, '-vn', '-af', chain.join(','), '-ar', String(CONFIG.sampleRate), '-ac', String(CONFIG.channels),
    '-c:a', 'libmp3lame', '-b:a', `${CONFIG.bitrate}k`, '-id3v2_version', '3', tmp]);
  fs.renameSync(tmp, dest);

  const doneDir = path.join(CONFIG.rawIntrosDir, 'done');
  ensureDir(doneDir);
  fs.renameSync(src, path.join(doneDir, path.basename(src)));
  return { dest, gainDb, preGainDb };
}

// Integrated loudness of the source take, for the pre-gain.
async function measureInputLufs(src) {
  try {
    const out = await runFfmpeg(['-i', src, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
    const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(out);
    if (!m) return null;
    const v = Number(JSON.parse(m[0]).input_i);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

class RawProcessor {
  constructor(onDone) {
    this.onDone = onDone;
    this.seen = new Map(); // file -> { size, mtime, stableScans }
    this.busy = false;
  }

  start() {
    ensureDir(CONFIG.rawIntrosDir);
    ensureDir(CONFIG.rawCleanIntrosDir);
    ensureDir(path.join(CONFIG.rawIntrosDir, 'songs'));
    ensureDir(path.join(CONFIG.rawIntrosDir, 'hourly'));
    this.timer = setInterval(() => this.scan().catch(e => logErr(`raw scan: ${e.message}`)), 5000);
    this.timer.unref();
    return this.scan();
  }

  stop() { clearInterval(this.timer); }

  async scan(force = false) {
    if (this.busy) return;
    // raw/ gets the echo effect; raw/clean/ is gain-only. Both land in intros/generic/.
    // raw/        -> intros/generic/  (echo + gain)      raw/clean/        -> gain only
    // raw/songs/  -> intros/songs/    (echo + gain)      raw/songs/clean/  -> gain only
    const sources = [
      { dir: CONFIG.rawIntrosDir, echo: true, destDir: CONFIG.genericBumpersDir },
      { dir: CONFIG.rawCleanIntrosDir, echo: false, destDir: CONFIG.genericBumpersDir },
      { dir: path.join(CONFIG.rawIntrosDir, 'songs'), echo: true, destDir: CONFIG.songIntrosDir },
      { dir: path.join(CONFIG.rawIntrosDir, 'songs', 'clean'), echo: false, destDir: CONFIG.songIntrosDir },
      { dir: path.join(CONFIG.rawIntrosDir, 'hourly'), echo: true, destDir: CONFIG.hourlyIntrosDir },
      { dir: path.join(CONFIG.rawIntrosDir, 'hourly', 'clean'), echo: false, destDir: CONFIG.hourlyIntrosDir },
    ];
    const files = [];
    this.echoFor = this.echoFor || new Map();
    this.destFor = this.destFor || new Map();
    for (const { dir, echo, destDir } of sources) {
      if (!fs.existsSync(dir)) continue;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.') || !AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
        const f = path.join(dir, e.name);
        files.push(f);
        this.echoFor.set(f, echo);
        this.destFor.set(f, destDir);
      }
    }

    const ready = [];
    for (const f of files) {
      const st = fs.statSync(f);
      const prev = this.seen.get(f);
      const stable = prev && prev.size === st.size && prev.mtime === st.mtimeMs;
      const entry = { size: st.size, mtime: st.mtimeMs, stableScans: stable ? prev.stableScans + 1 : 0 };
      this.seen.set(f, entry);
      if (force || entry.stableScans >= 2) ready.push(f);
    }
    for (const k of this.seen.keys()) if (!files.includes(k)) this.seen.delete(k);
    if (!ready.length) return;

    this.busy = true;
    try {
      for (const f of ready) {
        try {
          const echo = this.echoFor.get(f) !== false;
          const { dest, gainDb, preGainDb } = await processRawFile(f, { echo, destDir: this.destFor.get(f) });
          const stages = echo ? describeVoiceChain() : 'no effect';
          const pre = preGainDb ? `in ${preGainDb >= 0 ? '+' : ''}${preGainDb.toFixed(1)} dB > ` : '';
          logInfo(`${COLORS.magenta}processed${COLORS.reset} ${path.basename(f)} -> ${path.relative(__dirname, dest)} (${pre}${stages}, out ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB)`);
          this.seen.delete(f);
        } catch (e) {
          logErr(`failed to process ${path.basename(f)}: ${e.message} (will retry if the file changes)`);
          this.seen.get(f).stableScans = -Infinity;
        }
      }
      if (this.onDone) this.onDone();
    } finally {
      this.busy = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Playlist export: render a whole playlist, bumpers and intros included, into one
// mp3 for archiving. Nothing to do with the live stream — it runs as fast as the
// CPU allows, at low priority, and writes a tracklist and a .cue beside the audio.
// ---------------------------------------------------------------------------

function timecode(seconds) {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

// CUE wants mm:ss:ff with 75 frames per second, and minutes are not wrapped into hours.
function cueTime(seconds) {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total - Math.floor(total)) * 75);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

function cueEscape(text) {
  return String(text).replace(/"/g, "'").slice(0, 200);
}

class Exporter {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.current = null;
    this.log = [];
    this.cancelled = false;
  }

  status() {
    return { running: this.current, recent: this.log.slice(-5) };
  }

  // Build the running order without touching any live playout state.
  buildRunOrder(songs, { bumpers = true } = {}) {
    const items = [];
    let sinceBumper = 0;
    for (const song of songs) {
      const intro = this.scheduler.findMatchingIntro(song);
      if (bumpers) {
        if (intro) {
          items.push({ file: intro, kind: 'intro' });
        } else if (CONFIG.bumperEvery > 0) {
          sinceBumper += 1;
          if (sinceBumper >= CONFIG.bumperEvery) {
            const bumper = pickRandom(this.scheduler.genericBumpers);
            if (bumper) {
              items.push({ file: bumper, kind: 'bumper' });
              sinceBumper = 0;
            }
          }
        }
      }
      items.push({ file: song, kind: 'song' });
    }
    return items;
  }

  start(spec, { order = null, name = '', bumpers = true, limit = 0 } = {}) {
    if (this.current) return `an export is already running (${this.current.name}, ${this.current.done}/${this.current.total})`;

    this.scheduler.refresh();
    const names = parsePlaylistSpec(spec || this.scheduler.active.join(','));
    const lists = this.scheduler.playlists;
    const unknown = names.filter(n => n !== 'all' && !lists.has(n));
    if (unknown.length) return `no such playlist: ${unknown.join(', ')} (have: ${[...lists.keys()].join(', ')})`;

    let songs = names.includes('all')
      ? [...new Set([...lists.values()].flat())]
      : names.flatMap(n => lists.get(n) || []);
    if (!songs.length) return `playlist ${names.join(', ')} has no songs`;

    const useOrder = order || this.scheduler.order;
    if (useOrder === 'sequential') {
      const rel = f => path.relative(CONFIG.songsDir, f);
      const rank = new Map();
      for (const f of songs) {
        const list = readOrderFile(path.dirname(f));
        const i = list ? list.indexOf(normalizeName(path.basename(f, path.extname(f)))) : -1;
        rank.set(f, i < 0 ? Infinity : i);
      }
      songs = [...songs].sort((a, b) => (rank.get(a) - rank.get(b)) || naturalOrder.compare(rel(a), rel(b)));
    } else {
      songs = shuffle(songs);
    }
    if (limit > 0) songs = songs.slice(0, limit);

    const base = (name || `${names.join('-')}-${useOrder}-${new Date().toISOString().slice(0, 10)}`)
      .replace(/[\\/:*?"<>|]/g, '_');
    const items = this.buildRunOrder(songs, { bumpers });

    this.cancelled = false;
    this.current = { name: base, playlist: names.join(', '), order: useOrder, total: items.length, done: 0, songs: songs.length, startedAt: new Date().toISOString() };
    this.run(items, base).catch(e => logErr(`export failed: ${e.message}`)).finally(() => {
      this.log.push({ ...this.current, finishedAt: new Date().toISOString() });
      this.current = null;
    });
    return `exporting ${songs.length} songs (${items.length} items, ${useOrder}) to exports/${base}.mp3 — watch the console`;
  }

  cancel() {
    if (!this.current) return 'no export running';
    this.cancelled = true;
    return `cancelling export ${this.current.name}`;
  }

  // Decode one file, with its playback gain applied, into the open encoder.
  decodeInto(item, encoderStdin, onBytes) {
    return new Promise((resolve, reject) => {
      const filters = [];
      if (CONFIG.normalize && item.gainDb) filters.push(`volume=${item.gainDb.toFixed(2)}dB`);
      if (CONFIG.volume !== 1) filters.push(`volume=${CONFIG.volume}`);
      const [cmd, ...rest] = backgroundFfmpeg([
        '-i', item.file, '-vn', '-map', '0:a:0',
        ...(filters.length ? ['-af', filters.join(',')] : []),
        '-f', 's16le', '-ar', String(CONFIG.sampleRate), '-ac', String(CONFIG.channels), 'pipe:1',
      ]);
      const dec = spawn(cmd, rest, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let err = '';
      let ended = false;
      let closed = false;
      const done = () => { if (ended && closed) resolve(); };
      dec.stdout.on('data', c => onBytes(c.length));
      dec.stdout.pipe(encoderStdin, { end: false });
      dec.stdout.on('end', () => { ended = true; done(); });
      dec.stderr.on('data', d => { err += d.toString(); });
      dec.on('error', reject);
      dec.on('close', code => {
        closed = true;
        if (code && code !== 0) return reject(new Error(`${path.basename(item.file)}: ${err.trim().split(/\r?\n/).pop() || `exit ${code}`}`));
        done();
      });
      this.activeDecoder = dec;
    });
  }

  async run(items, base) {
    const dir = CONFIG.exportsDir;
    ensureDir(dir);
    const outPath = path.join(dir, `${base}.mp3`);
    const tmpPath = path.join(dir, `.${base}.part.mp3`);

    // Playback gain and titles up front, so the tracklist is right even if a file is odd.
    for (const item of items) {
      const meta = await probe(item.file);
      const parsed = parseSongInfo(item.file);
      item.artist = (meta && meta.artist) || parsed.artist;
      item.title = (meta && meta.title) || parsed.title;
      item.gainDb = CONFIG.normalize ? loudnessGainDb(await measureLoudness(item.file), item.kind) : 0;
    }

    const [ecmd, ...erest] = backgroundFfmpeg([
      '-y', '-f', 's16le', '-ar', String(CONFIG.sampleRate), '-ac', String(CONFIG.channels),
      '-channel_layout', CONFIG.channels === 1 ? 'mono' : 'stereo', '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', `${CONFIG.bitrate}k`, '-id3v2_version', '3',
      '-metadata', `title=${base}`, '-metadata', `artist=${CONFIG.name}`, '-metadata', `album=${CONFIG.name}`,
      tmpPath,
    ]);
    const enc = spawn(ecmd, erest, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let encErr = '';
    enc.stderr.on('data', d => { encErr += d.toString(); });
    const encDone = new Promise((resolve, reject) => {
      enc.on('error', reject);
      enc.on('close', code => (code === 0 ? resolve() : reject(new Error(encErr.trim().split(/\r?\n/).pop() || `encoder exit ${code}`))));
    });
    enc.stdin.on('error', () => { /* reported through encDone */ });

    const bytesPerSecond = CONFIG.sampleRate * CONFIG.channels * 2;
    let bytes = 0;
    const marks = [];
    const t0 = Date.now();

    // A track in the tracklist starts at its bumper/intro, so skipping to track N in a
    // player lands on the lead-in rather than dropping you mid-announcement.
    let blockStart = null;
    try {
      for (const [i, item] of items.entries()) {
        if (this.cancelled) throw new Error('cancelled');
        const startSec = bytes / bytesPerSecond;
        if (blockStart === null) blockStart = startSec;
        if (item.kind === 'song') marks.push({ at: blockStart, artist: item.artist, title: item.title });

        await this.decodeInto(item, enc.stdin, n => { bytes += n; });
        this.current.done = i + 1;

        if (item.kind === 'song') {
          blockStart = null;
          logInfo(`[export ${i + 1}/${items.length}] ${item.artist ? `${item.artist} - ` : ''}${item.title} (${(bytes / bytesPerSecond / 60).toFixed(1)} min so far)`);
        }
      }
    } finally {
      enc.stdin.end();
    }
    await encDone;
    fs.renameSync(tmpPath, outPath);

    // tracklist + cue
    const total = bytes / bytesPerSecond;
    const lines = marks.map((m, i) => `${String(i + 1).padStart(2, '0')}. ${timecode(m.at)}  ${m.artist ? `${m.artist} - ` : ''}${m.title}`);
    fs.writeFileSync(path.join(dir, `${base}.txt`),
      `${CONFIG.name} — ${this.current.playlist} (${this.current.order})${String.fromCharCode(10)}` +
      `${marks.length} tracks, ${timecode(total)}, rendered ${new Date().toISOString()}${String.fromCharCode(10)}${String.fromCharCode(10)}` +
      lines.join(String.fromCharCode(10)) + String.fromCharCode(10));

    const cue = [`PERFORMER "${cueEscape(CONFIG.name)}"`, `TITLE "${cueEscape(base)}"`, `FILE "${base}.mp3" MP3`];
    marks.forEach((m, i) => {
      cue.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`);
      cue.push(`    TITLE "${cueEscape(m.title)}"`);
      cue.push(`    PERFORMER "${cueEscape(m.artist || CONFIG.name)}"`);
      cue.push(`    INDEX 01 ${cueTime(m.at)}`);
    });
    fs.writeFileSync(path.join(dir, `${base}.cue`), cue.join(String.fromCharCode(10)) + String.fromCharCode(10));

    const sizeMB = (fs.statSync(outPath).size / 1048576).toFixed(1);
    const took = Math.round((Date.now() - t0) / 1000);
    logInfo(`${COLORS.magenta}export done${COLORS.reset} exports/${base}.mp3 — ${marks.length} tracks, ${timecode(total)}, ${sizeMB} MB, took ${took}s (tracklist: ${base}.txt, cue: ${base}.cue)`);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(req, res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  logReq(req, status);
}

// ?delay=24 (seconds) or ?delay=hls to see what an HLS listener is hearing right now.
function requestedDelay(url, playout) {
  const raw = (url.searchParams.get('delay') || '').trim().toLowerCase();
  if (!raw) return 0;
  if (raw === 'hls' || raw === 'auto') return playout.hlsDelaySeconds();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 600) : 0;
}

// Flat key=value lines: what Udon (VRCStringDownloader) can parse without a JSON step.
function nowPlayingText(playout, broadcaster, hlsAudience, delay) {
  const st = playout.status(delay);
  const n = st.now;
  const lines = [
    `station=${CONFIG.name}`,
    `kind=${n ? n.kind : 'none'}`,
    `artist=${n ? n.artist || '' : ''}`,
    `title=${n ? n.title || '' : ''}`,
    `display=${n ? n.display || '' : ''}`,
    `position=${n ? (n.position || 0).toFixed(1) : '0.0'}`,
    `duration=${n && n.duration ? n.duration.toFixed(1) : '0.0'}`,
    `next=${st.next ? st.next.display : ''}`,
    `playlist=${st.playlist ? st.playlist.display : ''}`,
    `playlistId=${st.playlist ? st.playlist.active.join(',') : ''}`,
    `listeners=${broadcaster.listeners.size + hlsAudience.size}`,
    `delay=${delay}`,
    `serverTime=${Math.round(Date.now() / 1000)}`,
  ];
  // Values must not contain newlines, or the line format breaks.
  return lines.map(l => l.replace(/[\r\n]+/g, ' ')).join(String.fromCharCode(10)) + String.fromCharCode(10);
}

function sendText(req, res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
  logReq(req, status);
}

function streamUrl(req) {
  if (CONFIG.publicUrl) return CONFIG.publicUrl.replace(/\/$/, '') + CONFIG.mount;
  return `http://${req.headers.host || `localhost:${CONFIG.port}`}${CONFIG.mount}`;
}

function serveStream(req, res, broadcaster) {
  const wantsMeta = req.method === 'GET' && String(req.headers['icy-metadata'] || '').trim() === '1';

  const headers = {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Accept-Ranges': 'none',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'icy-name, icy-br, icy-sr, icy-metaint, Content-Type',
    'X-Content-Type-Options': 'nosniff',
    'icy-name': CONFIG.name,
    'icy-description': CONFIG.description,
    'icy-genre': CONFIG.genre,
    'icy-br': String(CONFIG.bitrate),
    'icy-sr': String(CONFIG.sampleRate),
    'icy-pub': '0',
  };
  if (wantsMeta) headers['icy-metaint'] = String(CONFIG.icyMetaInt);

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    logReq(req, 200, '(HEAD live stream)');
    return;
  }

  // Icecast-style: no Content-Length, no chunked encoding, just bytes until the client leaves.
  res.useChunkedEncodingByDefault = false;
  res.sendDate = false;
  res.shouldKeepAlive = false;
  res.writeHead(200, headers);
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }
  res.flushHeaders();

  const l = broadcaster.add(res, wantsMeta);
  logReq(req, 200, `(live stream, listeners=${broadcaster.listeners.size}${wantsMeta ? ', icy-metadata' : ''})`);
  res.on('close', () => {
    const secs = Math.round((Date.now() - l.connectedAt) / 1000);
    logInfo(`listener left ${l.remote} after ${secs}s (listeners=${broadcaster.listeners.size})`);
  });
}

// HLS has no persistent connection, so "listeners" are clients that fetched a segment or
// re-polled the playlist recently. Behind a reverse proxy every request shares the proxy's
// IP, so the client key uses X-Forwarded-For / X-Real-IP when present and falls back to
// the socket address plus user-agent (which at least separates AVPro from browsers).
class HlsAudience {
  constructor() {
    this.clients = new Map();   // key -> { last, ip, ua, hits }
    this.peak = 0;
  }

  static clientIp(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req.headers['x-real-ip'] || (req.socket ? req.socket.remoteAddress : '?') || '?';
  }

  note(req) {
    const ip = HlsAudience.clientIp(req);
    const ua = String(req.headers['user-agent'] || 'unknown').slice(0, 80);
    const key = `${ip}|${ua}`;
    const entry = this.clients.get(key) || { ip, ua, hits: 0, since: Date.now() };
    entry.last = Date.now();
    entry.hits += 1;
    this.clients.set(key, entry);
    this.prune();
    this.peak = Math.max(this.peak, this.clients.size);
  }

  prune() {
    const cutoff = Date.now() - CONFIG.hlsListenerTimeout * 1000;
    for (const [key, e] of this.clients) if (e.last < cutoff) this.clients.delete(key);
  }

  get size() {
    this.prune();
    return this.clients.size;
  }

  list() {
    this.prune();
    return [...this.clients.values()].map(e => `${e.ip} ${e.ua.split(/[ /]/)[0]} (${Math.round((Date.now() - e.since) / 1000)}s, ${e.hits} reqs)`);
  }
}

// Archive renders. Supports Range so a browser can scrub a long file.
function serveExport(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.slice('/exports/'.length));
  if (!rel) {
    let files = [];
    try {
      files = fs.readdirSync(CONFIG.exportsDir)
        .filter(f => !f.startsWith('.'))
        .map(f => ({ f, s: fs.statSync(path.join(CONFIG.exportsDir, f)) }))
        .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
        .map(({ f, s }) => `${f}\t${(s.size / 1048576).toFixed(1)} MB`);
    } catch { /* none yet */ }
    return sendText(req, res, 200, files.join(String.fromCharCode(10)) + String.fromCharCode(10));
  }
  const abs = path.resolve(CONFIG.exportsDir, rel);
  if (!abs.startsWith(path.resolve(CONFIG.exportsDir)) || rel.includes('..')) return sendText(req, res, 400, 'Bad path');
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return sendText(req, res, 404, '404 Not found');
    const ext = path.extname(abs).toLowerCase();
    const type = ext === '.mp3' ? 'audio/mpeg' : ext === '.cue' ? 'application/x-cue' : 'text/plain; charset=utf-8';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
    if (range && ext === '.mp3') {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
    logReq(req, 200);
  });
}

function serveHls(req, res, urlPath, hlsAudience) {
  const rel = urlPath.slice('/hls/'.length);
  const abs = path.resolve(CONFIG.hlsDir, rel);
  if (!abs.startsWith(path.resolve(CONFIG.hlsDir)) || rel.includes('..')) return sendText(req, res, 400, 'Bad path');
  fs.stat(abs, (err, stats) => {
    if (err || !stats.isFile()) return sendText(req, res, 404, '404 Not found');
    const isPlaylist = abs.endsWith('.m3u8');
    res.writeHead(200, {
      'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Content-Length': stats.size,
      'Cache-Control': isPlaylist ? 'no-cache, no-store' : 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    });
    if (req.method === 'HEAD') return res.end();
    if (hlsAudience) hlsAudience.note(req);
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
    logReq(req, 200);
  });
}

function pageHtml(req) {
  const url = streamUrl(req);
  const hlsUrl = url.replace(CONFIG.mount, '') + '/hls/live.m3u8';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(CONFIG.name)}</title>
<style>
  :root{color-scheme:dark}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#111318;color:#e6e6ea;display:grid;place-items:center;min-height:100vh}
  main{width:min(560px,92vw);padding:28px;border:1px solid #2a2d36;border-radius:14px;background:#171a21}
  h1{margin:0 0 4px;font-size:22px}.live{display:inline-block;background:#e0302f;color:#fff;font-size:11px;font-weight:700;letter-spacing:.1em;padding:2px 8px;border-radius:999px;vertical-align:middle;margin-left:8px}
  .muted{color:#8a8f9c}.now{font-size:19px;margin:14px 0 2px}audio{display:none}code{background:#0d0f13;padding:2px 6px;border-radius:6px;font-size:13px}
  .pill{display:inline-block;margin-top:8px;padding:3px 10px;border:1px solid #2a2d36;border-radius:999px;font-size:12px;color:#b9c0cf;background:#13161d}
  .pill:empty{display:none}
  .controls{display:flex;align-items:center;gap:12px;margin:18px 0 10px}
  .controls button{width:44px;height:44px;border-radius:50%;border:1px solid #2a2d36;background:#20242e;color:#e6e6ea;font-size:16px;cursor:pointer;line-height:1}
  .controls button:hover{background:#262b36}
  .controls input[type=range]{flex:1;accent-color:#7aa2ff}
  .bar{height:4px;background:#2a2d36;border-radius:2px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#7aa2ff}
</style></head><body><main>
<h1>${escapeHtml(CONFIG.name)}<span class="live">LIVE</span></h1>
<div class="muted">${escapeHtml(CONFIG.description)}</div>
<div class="pill" id="playlist"></div>
<div class="now" id="now">…</div><div class="muted" id="time"></div><div class="bar"><i id="bar"></i></div>
<div class="muted" id="next" style="margin-top:8px"></div>
<audio id="player" preload="none"${CONFIG.hls ? '' : ` src="${CONFIG.mount}"`}></audio>
<div class="controls">
  <button id="playBtn" title="Play">&#9654;</button>
  <span class="muted" id="state">paused</span>
  <input id="vol" type="range" min="0" max="100" value="100" title="Volume">
  <span class="muted" id="sync"></span>
</div>
<div class="muted">${CONFIG.hls ? `VRChat / HLS URL: <code>${escapeHtml(hlsUrl)}</code><br>` : ''}MP3 URL: <code>${escapeHtml(url)}</code> · <span id="listeners"></span></div>
</main>
${CONFIG.hls ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.15/hls.min.js"></script>' : ''}
<script>
// This page sits much closer to the live edge than AVPro does, so it measures its own lag
// from the stream's PROGRAM-DATE-TIME rather than assuming the AVPro figure.
var hls=null, lag=${CONFIG.hls ? CONFIG.hlsSegmentSeconds * 3 : 0};
${CONFIG.hls ? `(function(){const a=document.getElementById('player');const src='/hls/live.m3u8';
if(window.Hls&&Hls.isSupported()){hls=new Hls({liveSyncDurationCount:3,backBufferLength:30});hls.loadSource(src);hls.attachMedia(a);}
else if(a.canPlayType('application/vnd.apple.mpegurl')){a.src=src;}
else{a.src='${CONFIG.mount}';lag=0;}})();` : ''}
const fmt=s=>{s=Math.max(0,Math.floor(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
// ?trim=N adds N seconds to the measured lag (the playlist's PROGRAM-DATE-TIME is anchored
// about one segment late, and players differ), so the display can be dialled in live.
const trim=Number(new URLSearchParams(location.search).get('trim')||0)||0;
// ffmpeg anchors the first PROGRAM-DATE-TIME about one segment after that audio actually
// entered the encoder, so playingDate reads late and the measured lag comes out low by
// roughly one segment. Without this the title changes before you hear the song.
const pdtCorrection=${CONFIG.hls ? CONFIG.hlsSegmentSeconds : 0};
let measured=null;
function measure(serverTime){try{
  if(!hls||!hls.playingDate)return;
  const d=(Date.parse(serverTime)-hls.playingDate.getTime())/1000;
  if(isFinite(d)&&d>=0&&d<300){measured=d;lag=d+pdtCorrection+trim;}
}catch(e){}}

const player=document.getElementById('player');
const playBtn=document.getElementById('playBtn');
const stateEl=document.getElementById('state');
playBtn.onclick=()=>{if(player.paused){player.play();}else{player.pause();}};
player.onplay=()=>{playBtn.innerHTML='&#10073;&#10073;';playBtn.title='Pause';stateEl.textContent='live';};
player.onpause=()=>{playBtn.innerHTML='&#9654;';playBtn.title='Play';stateEl.textContent='paused';};
const vol=document.getElementById('vol');
vol.oninput=()=>{player.volume=vol.value/100;};
async function poll(){try{const r=await fetch('/now.json?delay='+Math.max(0,Math.round(lag)),{cache:'no-store'});const j=await r.json();
measure(j.serverTime);
const n=j.now;document.getElementById('now').textContent=n?(n.kind==='song'?n.display:'['+n.kind+'] '+n.display):'(silence)';
document.getElementById('time').textContent=n?fmt(n.position)+(n.duration?' / '+fmt(n.duration):''):'';
document.getElementById('bar').style.width=n&&n.duration?Math.min(100,100*n.position/n.duration)+'%':'0';
document.getElementById('next').textContent=j.next?'Up next: '+j.next.display:'';
document.getElementById('listeners').textContent=j.listeners+' listening';
document.getElementById('playlist').textContent=j.playlist&&j.playlist.display?j.playlist.display:'';
document.getElementById('sync').textContent=measured===null?'':('sync '+lag.toFixed(1)+'s behind live'+(trim?' (trim '+(trim>0?'+':'')+trim+')':''));
}catch(e){}}
poll();setInterval(poll,2000);
</script></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function authorized(url) {
  return CONFIG.adminToken && url.searchParams.get('token') === CONFIG.adminToken;
}

function createServer(playout, broadcaster, importer, hlsAudience, exporter) {
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendText(req, res, 400, 'Bad request');
    }
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Icy-MetaData, Range',
      });
      return res.end();
    }

    if (p === CONFIG.mount || p === '/stream' || p === '/live') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(req, res, 405, 'Method not allowed');
      return serveStream(req, res, broadcaster);
    }

    if (p === '/now.txt') {
      return sendText(req, res, 200, nowPlayingText(playout, broadcaster, hlsAudience, requestedDelay(url, playout)));
    }

    if (p === '/now.json' || p === '/status.json') {
      return sendJson(req, res, 200, {
        ...playout.status(requestedDelay(url, playout)),
        listeners: broadcaster.listeners.size + hlsAudience.size,
        listenersMp3: broadcaster.listeners.size,
        listenersHls: hlsAudience.size,
        peakListeners: Math.max(broadcaster.peakListeners, hlsAudience.peak),
        stream: { url: streamUrl(req), format: 'mp3', bitrate: CONFIG.bitrate, sampleRate: CONFIG.sampleRate, hls: CONFIG.hls ? `${streamUrl(req).replace(CONFIG.mount, '')}/hls/live.m3u8` : null },
        encoderRestarts: playout.encoder.restarts,
        import: importer ? importer.status() : null,
        memoryMB: Math.round(process.memoryUsage().rss / 1048576),
        burstBufferKB: Math.round(broadcaster.ring.reduce((a, r) => a + r.buf.length, 0) / 1024),
      });
    }

    if (p === '/history.json') return sendJson(req, res, 200, { history: playout.history });
    if (p === '/health') return sendText(req, res, 200, 'ok');

    if (p === '/' || p === '/index.html') {
      const html = pageHtml(req);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return logReq(req, 200);
    }

    if (CONFIG.hls && p.startsWith('/hls/')) return serveHls(req, res, p, hlsAudience);
    if (p.startsWith('/exports/')) return serveExport(req, res, p);

    if (importer && p.startsWith('/spotify/')) {
      importer.handleHttp(req, res, url, sendText, authorized).then(handled => { if (!handled) sendText(req, res, 404, '404 Not found'); });
      return;
    }

    if (p === '/skip' || p === '/reload' || p === '/seek' || p === '/playlist' || p === '/import' || p === '/play' || p === '/export') {
      if (req.method !== 'POST') return sendText(req, res, 405, 'POST required');
      if (!authorized(url)) return sendText(req, res, 403, 'Forbidden');
      if (p === '/skip') return sendText(req, res, 200, playout.skip() ? 'skipped' : 'nothing playing');
      if (p === '/export') {
        if (!exporter) return sendText(req, res, 503, 'exporter not ready');
        return sendText(req, res, 200, exporter.start(url.searchParams.get('playlist') || '', {
          order: parseOrderWord(url.searchParams.get('order') || ''),
          name: url.searchParams.get('name') || '',
          bumpers: url.searchParams.get('bumpers') !== '0',
          limit: Number(url.searchParams.get('limit')) || 0,
        }));
      }
      if (p === '/import') {
        if (!importer) return sendText(req, res, 501, 'importer.mjs not installed');
        return sendText(req, res, 200, importer.enqueue(url.searchParams.get('url') || '', url.searchParams.get('folder') || '', Number(url.searchParams.get('limit')) || 0));
      }
      if (p === '/play') {
        return sendText(req, res, 200, playout.request(url.searchParams.get('q') || '', url.searchParams.get('now') === '1'));
      }
      if (p === '/playlist') {
        return sendText(req, res, 200, playout.setPlaylist(url.searchParams.get('name') || '', {
          now: url.searchParams.get('now') === '1',
          order: parseOrderWord(url.searchParams.get('order') || ''),
          reset: url.searchParams.get('reset') === '1',
        }));
      }
      if (p === '/seek') {
        const to = url.searchParams.get('to');
        const by = url.searchParams.get('by');
        return sendText(req, res, 200, playout.seek(to != null ? to : by != null ? (by.startsWith('-') ? by : `+${by}`) : ''));
      }
      playout.reload();
      return sendText(req, res, 200, 'reloaded');
    }

    sendText(req, res, 404, '404 Not found');
  });

  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function checkTools() {
  return new Promise(resolve => {
    execFile(CONFIG.ffmpeg, ['-hide_banner', '-encoders'], { windowsHide: true }, (err, stdout) => {
      if (err) {
        logErr(`cannot run ffmpeg (${CONFIG.ffmpeg}): ${err.message}`);
        logErr('Install ffmpeg, or set FFMPEG_PATH / FFPROBE_PATH to the binaries.');
        return resolve(false);
      }
      if (!/libmp3lame/.test(stdout)) {
        logErr('this ffmpeg build has no libmp3lame encoder; the MP3 stream cannot be produced');
        return resolve(false);
      }
      if (CONFIG.hls && !stdout.split(String.fromCharCode(10)).some(l => l.trim().split(/ +/)[1] === 'aac')) logWarn('this ffmpeg build has no aac encoder; HLS output will fail');
      execFile(CONFIG.ffprobe, ['-version'], { windowsHide: true }, err2 => {
        if (err2) logWarn(`cannot run ffprobe (${CONFIG.ffprobe}): durations/tags will be missing`);
        resolve(true);
      });
    });
  });
}

async function main() {
  if (!(await checkTools())) process.exit(1);

  if (CONFIG.hls) {
    ensureDir(CONFIG.hlsDir);
    for (const f of fs.readdirSync(CONFIG.hlsDir)) {
      if (/\.(ts|m3u8)$/.test(f)) fs.unlinkSync(path.join(CONFIG.hlsDir, f));
    }
  }

  const scheduler = new RadioScheduler();
  const rawProcessor = new RawProcessor(() => scheduler.refresh());
  const exporter = new Exporter(scheduler);
  // Optional playlist importer (importer.mjs next to this file). Absent = command disabled.
  let importer = null;
  try {
    const mod = await import('./importer.mjs');
    importer = mod.createImporter({ CONFIG, __dirname, ensureDir, getAudioFilesRecursive, normalizeName, runFfmpeg, logInfo, logWarn, logErr, COLORS, AUDIO_EXTENSIONS }, scheduler);
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') logErr(`importer.mjs failed to load: ${e.message}`);
  }
  const NO_IMPORTER = 'playlist import not installed: upload importer.mjs next to netradio.js';
  await rawProcessor.start();
  const encoder = new Encoder();
  const playout = new Playout(scheduler, encoder);
  const broadcaster = new Broadcaster(playout);
  const hlsAudience = new HlsAudience();
  encoder.on('data', chunk => broadcaster.onEncoded(chunk));

  const server = createServer(playout, broadcaster, importer, hlsAudience, exporter);
  server.on('error', err => {
    logErr(`http server error: ${err.message}`);
    process.exit(1);
  });

  encoder.start();
  await playout.start();

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`${COLORS.green}Live radio running at http://localhost:${CONFIG.port}${CONFIG.mount}${COLORS.reset}`);
    console.log(`${COLORS.cyan}Songs dir:    ${CONFIG.songsDir} (${scheduler.songPool.length} songs)${COLORS.reset}`);
    console.log(`${COLORS.cyan}Playlist:     ${scheduler.active.join(', ')} (${scheduler.order}${scheduler.restoredPlaylist ? ', restored' : ''}) — available: ${Object.entries(scheduler.playlistInfo().available).map(([n, c]) => `${n} (${c})`).join(', ')}${COLORS.reset}`);
    console.log(`${COLORS.cyan}Song intros:  ${CONFIG.songIntrosDir} (${scheduler.songIntroMap.size})${COLORS.reset}`);
    console.log(`${COLORS.cyan}Bumpers:      ${CONFIG.genericBumpersDir} (${scheduler.genericBumpers.length}, every ${CONFIG.bumperEvery} song(s))${COLORS.reset}`);
    console.log(`${COLORS.cyan}Encoder:      mp3 ${CONFIG.bitrate}k ${CONFIG.sampleRate}Hz, burst ${CONFIG.burstSeconds}s, normalize=${CONFIG.normalize ? 'on' : 'off'}${CONFIG.hls ? `, HLS at /hls/live.m3u8` : ''}${COLORS.reset}`);
    console.log(`${COLORS.cyan}Station time: ${stationClockString()} (STATION_TZ=${CONFIG.timezone})${COLORS.reset}`);
    console.log(`${COLORS.cyan}Now playing:  http://localhost:${CONFIG.port}/now.json${COLORS.reset}`);
    if (!CONFIG.adminToken) console.log(`${COLORS.yellow}ADMIN_TOKEN not set: /skip and /reload disabled${COLORS.reset}`);
  });

  const shutdown = () => {
    logInfo('shutting down');
    playout.stop();
    encoder.stop();
    rawProcessor.stop();
    for (const l of broadcaster.listeners) { try { l.res.destroy(); } catch { /* ignore */ } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Console commands (type them into the Pterodactyl console or the terminal).
  const commands = {
    skip: () => (playout.skip() ? '' : 'nothing playing'),
    next: () => commands.skip(),
    seek: arg => playout.seek(arg),
    play: arg => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return 'usage: play <part of song name> [now]';
      const now = parts.length > 1 && parts[parts.length - 1].toLowerCase() === 'now';
      return playout.request((now ? parts.slice(0, -1) : parts).join(' '), now);
    },
    playlist: arg => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) {
        const i = scheduler.playlistInfo();
        return `active: ${i.display} [${i.active.join(', ')}] (${i.order}) — available: ${Object.entries(i.available).map(([n, c]) => `${i.names[n]} / ${n} (${c})`).join(', ')}`;
      }
      if (parts[0].toLowerCase() === 'reset') return playout.setPlaylist('', { reset: true });

      // Split the words into playlist name(s), an order, and "now". A playlist whose name
      // happens to be "random" or "sequential" still wins over the keyword.
      const known = scheduler.scanPlaylists();
      let now = false;
      let order = null;
      const names = [];
      for (const word of parts) {
        const lower = word.toLowerCase();
        if (known.has(lower)) { names.push(word); continue; }
        if (lower === 'now') { now = true; continue; }
        const asOrder = parseOrderWord(lower);
        if (asOrder) { order = asOrder; continue; }
        names.push(word);
      }
      const spec = names.join(' ');
      if (!spec) {
        if (!order) return 'usage: playlist <name> [sequential|random] [now] | playlist reset';
        return playout.setPlaylist(scheduler.active.join(','), { now, order });  // order-only change
      }
      return playout.setPlaylist(spec, { now, order });
    },
    playlists: () => commands.playlist(''),
    bumper: arg => playout.queueBumper(arg.trim()),
    import: arg => {
      if (!importer) return NO_IMPORTER;
      const [url, folder, limit] = arg.trim().split(/\s+/);
      return importer.enqueue(url || '', folder || '', Number(limit) || 0);
    },
    imports: () => {
      if (!importer) return NO_IMPORTER;
      const st = importer.status();
      const cur = st.running ? `running: ${st.running.url} -> songs/${st.running.folder || '?'} (${st.running.done}/${st.running.total - st.running.skipped}, ok ${st.running.ok}, missed ${st.running.failed})` : 'nothing running';
      return `${cur}${st.queued.length ? ` | queued: ${st.queued.length}` : ''}${st.recent.length ? ` | last: ${st.recent[st.recent.length - 1].ok} ok / ${st.recent[st.recent.length - 1].failed} missed` : ''}`;
    },
    spotify: () => (importer ? importer.spotifyStatus() : NO_IMPORTER),
    ytdlp: async () => (importer ? logInfo(`yt-dlp: ${await importer.ytdlp.update()}`) : NO_IMPORTER),
    reload: () => { playout.reload(); return ''; },
    now: () => {
      const s = playout.status();
      const n = s.now;
      const pos = n ? `${Math.floor(n.position)}s${n.duration ? ` / ${Math.floor(n.duration)}s` : ''}` : '';
      return `${n ? `[${n.kind}] ${n.display} (${pos})` : '(silence)'} | next: ${s.next ? s.next.display : '-'} | listeners: ${broadcaster.listeners.size}`;
    },
    listeners: () => {
      const mp3 = [...broadcaster.listeners].map(l => `${l.remote} (${Math.round((Date.now() - l.connectedAt) / 1000)}s)`);
      const hls = hlsAudience.list();
      if (!mp3.length && !hls.length) return 'no listeners';
      return [
        `mp3 (${mp3.length}): ${mp3.join(', ') || 'none'}`,
        `hls (${hls.length}, active within ${CONFIG.hlsListenerTimeout}s): ${hls.join(', ') || 'none'}`,
      ].join(String.fromCharCode(10));
    },
    queue: () => playout.status().upcoming.join('\n') || '(queue empty)',
    hourly: arg => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      if (parts.length && ['play', 'test'].includes(parts[0].toLowerCase())) {
        return playout.forceHourly(parts.slice(1).join(' '));
      }
      scheduler.refresh();
      if (!scheduler.hourlyMap.size) return `no time checks installed — drop files in ${path.relative(__dirname, CONFIG.hourlyIntrosDir)} named 0-23 or 1am..12pm`;
      const have = [...scheduler.hourlyMap.keys()].sort((a, b) => a - b);
      const missing = [];
      for (let h = 0; h < 24; h += 1) if (!scheduler.hourlyMap.has(h)) missing.push(h);
      const now = stationNow();
      const done = now.key === scheduler.lastHourKey;
      return `time checks: ${have.length}/24 hours covered (${have.map(h => `${h}${scheduler.hourlyMap.get(h).length > 1 ? `x${scheduler.hourlyMap.get(h).length}` : ''}`).join(' ')})`
        + (missing.length ? `; missing: ${missing.join(' ')}` : '')
        + ` | station time ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')} ${CONFIG.timezone}`
        + ` | this hour: ${done ? `done (${scheduler.lastHourWhy || 'played'})` : scheduler.hourlyMap.has(now.hour) ? (now.minute > CONFIG.hourlyGraceMinutes ? 'too late, will skip' : 'due at the next break') : 'no clip'}`;
    },
    intros: () => {
      // Which songs (in every playlist) have a song-specific intro, and which still need one.
      scheduler.refresh();
      const all = [...new Set([...scheduler.playlists.values()].flat())];
      const missing = all.filter(f => !scheduler.findMatchingIntro(f));
      const report = path.join(CONFIG.songIntrosDir, 'missing-intros.txt');
      fs.writeFileSync(report, missing.map(f => path.basename(f, path.extname(f))).sort().join(String.fromCharCode(10)) + String.fromCharCode(10));
      const unused = [...scheduler.songIntroMap.values()].filter(i => !all.some(f => scheduler.findMatchingIntro(f) === i));
      return `song intros: ${all.length - missing.length}/${all.length} songs covered; ${missing.length} missing (listed in ${path.relative(__dirname, report)})` +
        (unused.length ? `; ${unused.length} intro file(s) match no song: ${unused.map(u => path.basename(u)).join(', ')}` : '');
    },
    export: arg => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === 'cancel') return exporter.cancel();
      let order = null;
      let bumpers = true;
      let limit = 0;
      const rest = [];
      const known = scheduler.scanPlaylists();
      for (const w of parts) {
        const l = w.toLowerCase();
        if (known.has(l)) { rest.push(w); continue; }
        const o = parseOrderWord(l);
        if (o) { order = o; continue; }
        if (l === 'nobumpers' || l === 'no-bumpers') { bumpers = false; continue; }
        if (/^\d+$/.test(l)) { limit = Number(l); continue; }
        rest.push(w);
      }
      const spec = rest.shift() || '';
      return exporter.start(spec, { order, name: rest.join(' '), bumpers, limit });
    },
    exports: () => {
      const st = exporter.status();
      const running = st.running ? `running: ${st.running.name} (${st.running.done}/${st.running.total})` : 'nothing running';
      let listed = [];
      try {
        listed = fs.readdirSync(CONFIG.exportsDir).filter(f => f.endsWith('.mp3'))
          .map(f => `${f} (${(fs.statSync(path.join(CONFIG.exportsDir, f)).size / 1048576).toFixed(1)} MB)`);
      } catch { /* no exports yet */ }
      return `${running}${String.fromCharCode(10)}on disk: ${listed.join(', ') || 'none'}`;
    },
    fx: () => `${describeVoiceChain()}${String.fromCharCode(10)}ffmpeg -af "${voiceChainFilters({}).join(',')}"`,
    process: () => { rawProcessor.scan(true).catch(e => logErr(e.message)); return `processing ${CONFIG.rawIntrosDir}`; },
    check: arg => {
      // check            bumpers + song intros
      // check all        + every song in every playlist
      // check <playlist> songs of that playlist only
      scheduler.refresh();
      const which = arg.trim().toLowerCase();
      let files;
      const hourlyFiles = [...scheduler.hourlyMap.values()].flat();
      if (!which) files = [...scheduler.genericBumpers, ...scheduler.songIntroMap.values(), ...hourlyFiles];
      else if (which === 'all') files = [...scheduler.genericBumpers, ...scheduler.songIntroMap.values(), ...hourlyFiles, ...new Set([...scheduler.playlists.values()].flat())];
      else if (scheduler.playlists.has(which)) files = scheduler.playlists.get(which);
      else return `no playlist "${which}" (have: ${[...scheduler.playlists.keys()].join(', ')}) — or use: check | check all`;
      if (!files.length) return 'nothing to check';
      logInfo(`checking ${files.length} file(s) (full decode)...`);
      let i = 0;
      let failed = 0;
      const next = () => {
        if (i >= files.length) return (failed ? logWarn : logInfo)(`check done: ${files.length - failed} ok, ${failed} failed`);
        const f = files[i++];
        // Full decode. ffmpeg keeps going past recoverable errors with exit code 0, so any
        // line on stderr counts as a failure, not just a non-zero exit.
        const [cmd, ...rest] = backgroundFfmpeg(['-v', 'error', '-i', f, '-f', 'null', '-']);
        execFile(cmd, rest, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
          const rel = path.relative(__dirname, f);
          const errs = (stderr || '').trim().split(/\r?\n/).filter(Boolean);
          if (err || errs.length) {
            failed += 1;
            logErr(`FAIL ${rel}: ${errs[errs.length - 1] || err.message}${errs.length > 1 ? ` (+${errs.length - 1} more)` : ''}`);
          } else {
            logInfo(`ok   ${rel}`);
          }
          next();
        });
      };
      next();
      return '';
    },
    stop: () => { shutdown(); return ''; },
    help: () => 'commands: skip | play <song> [now] | seek +30 | seek 1:30 | now | queue | bumper [name] | playlists | playlist <name> [now] | import <url> [folder] | imports | spotify | ytdlp | listeners | check [all|<playlist>] | export <playlist> [sequential|random] [nobumpers] | exports | fx | intros | hourly [play [hour]] | process | reload | stop',
  };
  process.stdin.on('data', chunk => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [cmd, ...rest] = trimmed.split(/\s+/);
      const fn = commands[cmd.toLowerCase()];
      Promise.resolve(fn ? fn(rest.join(' ')) : `unknown command "${cmd}" — ${commands.help()}`)
        .then(out => { if (out) logInfo(out); })
        .catch(e => logErr(`${cmd}: ${e.message}`));
    }
  });
  process.stdin.on('error', () => { /* no stdin attached */ });
}

main().catch(err => {
  logErr(err.stack || String(err));
  process.exit(1);
});
