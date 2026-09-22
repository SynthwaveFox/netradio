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
  bumperEvery: Number(process.env.BUMPER_EVERY || 1), // generic bumper before every Nth song (0 = never)
  playlist: process.env.PLAYLIST || 'default',   // songs/<folder> to play; 'default' = loose files in songs/; 'all'; or 'a,b'

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
  hlsWindowSegments: Number(process.env.HLS_WINDOW_SEGMENTS || 6),  // playlist length. Players start at its FIRST segment, so this is the tune-in delay
  hlsKeepSegments: Number(process.env.HLS_KEEP_SEGMENTS || 15),     // extra expired segments kept on disk for players that fell behind

  adminToken: process.env.ADMIN_TOKEN || '',

  // Raw bumper processing (see RawProcessor): intros/raw -> intros/generic
  rawIntrosDir: process.env.RAW_INTROS_DIR || path.join(__dirname, 'intros', 'raw'),
  get rawCleanIntrosDir() { return process.env.RAW_CLEAN_INTROS_DIR || path.join(this.rawIntrosDir, 'clean'); }, // gain only, no echo
  processEchoDelayMs: Number(process.env.PROCESS_ECHO_DELAY_MS || 10),   // Audacity Echo "delay time" 0.01 s
  processEchoDecay: Number(process.env.PROCESS_ECHO_DECAY || 0.5),      // Audacity Echo "decay factor"
  processPeakDb: Number(process.env.PROCESS_PEAK_DB || -1),             // peak-normalise target
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

function nowEST() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function stamp() {
  return `${COLORS.cyan}[${nowEST()} EST]${COLORS.reset}`;
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

function getAudioFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

function parsePlaylistSpec(spec) {
  return String(spec || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

class RadioScheduler {
  constructor() {
    this.songPool = [];
    this.playlists = new Map();  // name -> files. Subfolders of songs/ are playlists; loose files are 'default'
    this.active = parsePlaylistSpec(CONFIG.playlist);
    this.genericBumpers = [];
    this.songIntroMap = new Map();
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
  setPlaylist(spec) {
    const names = parsePlaylistSpec(spec);
    if (!names.length) return 'usage: playlist <name> | playlist a,b | playlist all';
    this.playlists = this.scanPlaylists();
    const unknown = names.filter(n => n !== 'all' && !this.playlists.has(n));
    if (unknown.length) return `no such playlist: ${unknown.join(', ')} (have: ${[...this.playlists.keys()].join(', ')})`;
    this.active = names;
    this.warnedMissing = false;
    this.refresh();
    this.rebuildQueue();
    return `playlist: ${names.join(', ')} (${this.songPool.length} songs)`;
  }

  playlistInfo() {
    this.playlists = this.scanPlaylists();
    const available = {};
    for (const [name, files] of this.playlists) available[name] = files.length;
    return { active: this.active, available };
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

    const pool = new Set(this.songPool);
    this.queue = this.queue.filter(f => pool.has(f));
    for (const f of this.songPool) {
      if (!known.has(f)) this.queue.splice(Math.floor(Math.random() * (this.queue.length + 1)), 0, f);
    }

    const after = { songs: this.songPool.length, bumpers: this.genericBumpers.length, intros: this.songIntroMap.size };
    const diff = Object.keys(after).filter(k => after[k] !== before[k]).map(k => `${k} ${before[k]} -> ${after[k]}`);
    if (diff.length && this.scannedOnce) logInfo(`library changed: ${diff.join(', ')}`);
    this.scannedOnce = true;
  }

  rebuildQueue() {
    const shuffled = shuffle(this.songPool);
    if (shuffled.length > 1 && this.lastSong && shuffled[0] === this.lastSong) {
      shuffled.push(shuffled.shift());
    }
    this.queue = shuffled;
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
    const next = this.queue.shift() || null;
    this.lastSong = next;
    return next;
  }

  // Returns [{file, kind}] for the next playout block: [intro|bumper], song
  getNextPlayoutItems() {
    const song = this.getNextSong();
    if (!song) return [];
    return this.playoutItemsFor(song);
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
    if (this.current) {
      this.current.destroy();
      this.history.unshift({ ...this.current.toJSON(), endedAt: new Date().toISOString() });
      this.history.length = Math.min(this.history.length, 50);
    }
    this.fill();
    this.current = this.pending.shift() || null;
    if (this.current) {
      if (!this.current.startRequested) this.current.start();
      this.current.startedAt = new Date().toISOString();
      this.fill(); // kick decoding for the following item
      const cur = this.current;
      cur.ready.then(() => logInfo(`${COLORS.magenta}▶ ${cur.kind}${COLORS.reset} ${cur.displayTitle}${CONFIG.normalize && cur.loudness ? ` (${cur.loudness.i.toFixed(1)} LUFS, gain ${cur.gainDb >= 0 ? '+' : ''}${cur.gainDb.toFixed(1)} dB)` : ''}`));
      this.emit('track', this.current);
    } else {
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
  setPlaylist(spec, now = false) {
    const msg = this.scheduler.setPlaylist(spec);
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

  status() {
    const nextSong = this.pending.find(t => t.kind === 'song');
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
  const chain = echo ? [echoFilter()] : [];

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
  return { dest, gainDb };
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
          const { dest, gainDb } = await processRawFile(f, { echo, destDir: this.destFor.get(f) });
          logInfo(`${COLORS.magenta}processed${COLORS.reset} ${path.basename(f)} -> ${path.relative(__dirname, dest)} (${echo ? `echo ${CONFIG.processEchoDelayMs}ms/${CONFIG.processEchoDecay}, ` : 'no effect, '}gain ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB)`);
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

function serveHls(req, res, urlPath) {
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
  .muted{color:#8a8f9c}.now{font-size:19px;margin:14px 0 2px}audio{width:100%;margin:18px 0 10px}code{background:#0d0f13;padding:2px 6px;border-radius:6px;font-size:13px}
  .bar{height:4px;background:#2a2d36;border-radius:2px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#7aa2ff}
</style></head><body><main>
<h1>${escapeHtml(CONFIG.name)}<span class="live">LIVE</span></h1>
<div class="muted">${escapeHtml(CONFIG.description)}</div>
<div class="now" id="now">…</div><div class="muted" id="time"></div><div class="bar"><i id="bar"></i></div>
<div class="muted" id="next" style="margin-top:8px"></div>
<audio id="player" controls preload="none"${CONFIG.hls ? '' : ` src="${CONFIG.mount}"`}></audio>
<div class="muted">${CONFIG.hls ? `VRChat / HLS URL: <code>${escapeHtml(hlsUrl)}</code><br>` : ''}MP3 URL: <code>${escapeHtml(url)}</code> · <span id="listeners"></span></div>
</main>
${CONFIG.hls ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.15/hls.min.js"></script>' : ''}
<script>
${CONFIG.hls ? `(function(){const a=document.getElementById('player');const src='/hls/live.m3u8';
if(a.canPlayType('application/vnd.apple.mpegurl')){a.src=src;}
else if(window.Hls&&Hls.isSupported()){const h=new Hls({liveSyncDurationCount:3,backBufferLength:30});h.loadSource(src);h.attachMedia(a);}
else{a.src='${CONFIG.mount}';}})();` : ''}
const fmt=s=>{s=Math.max(0,Math.floor(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
async function poll(){try{const r=await fetch('/now.json',{cache:'no-store'});const j=await r.json();
const n=j.now;document.getElementById('now').textContent=n?(n.kind==='song'?n.display:'['+n.kind+'] '+n.display):'(silence)';
document.getElementById('time').textContent=n?fmt(n.position)+(n.duration?' / '+fmt(n.duration):''):'';
document.getElementById('bar').style.width=n&&n.duration?Math.min(100,100*n.position/n.duration)+'%':'0';
document.getElementById('next').textContent=j.next?'Up next: '+j.next.display:'';
document.getElementById('listeners').textContent=j.listeners+' listening';}catch(e){}}
poll();setInterval(poll,2000);
</script></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function authorized(url) {
  return CONFIG.adminToken && url.searchParams.get('token') === CONFIG.adminToken;
}

function createServer(playout, broadcaster, importer) {
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

    if (p === '/now.json' || p === '/status.json') {
      return sendJson(req, res, 200, {
        ...playout.status(),
        listeners: broadcaster.listeners.size,
        peakListeners: broadcaster.peakListeners,
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

    if (CONFIG.hls && p.startsWith('/hls/')) return serveHls(req, res, p);

    if (importer && p.startsWith('/spotify/')) {
      importer.handleHttp(req, res, url, sendText, authorized).then(handled => { if (!handled) sendText(req, res, 404, '404 Not found'); });
      return;
    }

    if (p === '/skip' || p === '/reload' || p === '/seek' || p === '/playlist' || p === '/import' || p === '/play') {
      if (req.method !== 'POST') return sendText(req, res, 405, 'POST required');
      if (!authorized(url)) return sendText(req, res, 403, 'Forbidden');
      if (p === '/skip') return sendText(req, res, 200, playout.skip() ? 'skipped' : 'nothing playing');
      if (p === '/import') {
        if (!importer) return sendText(req, res, 501, 'importer.mjs not installed');
        return sendText(req, res, 200, importer.enqueue(url.searchParams.get('url') || '', url.searchParams.get('folder') || '', Number(url.searchParams.get('limit')) || 0));
      }
      if (p === '/play') {
        return sendText(req, res, 200, playout.request(url.searchParams.get('q') || '', url.searchParams.get('now') === '1'));
      }
      if (p === '/playlist') {
        return sendText(req, res, 200, playout.setPlaylist(url.searchParams.get('name') || '', url.searchParams.get('now') === '1'));
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
  // Optional playlist importer (importer.mjs next to this file). Absent = command disabled.
  let importer = null;
  try {
    const mod = await import('./importer.mjs');
    importer = mod.createImporter({ CONFIG, __dirname, ensureDir, getAudioFilesRecursive, normalizeName, runFfmpeg, logInfo, logWarn, logErr, COLORS }, scheduler);
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') logErr(`importer.mjs failed to load: ${e.message}`);
  }
  const NO_IMPORTER = 'playlist import not installed: upload importer.mjs next to netradio.js';
  await rawProcessor.start();
  const encoder = new Encoder();
  const playout = new Playout(scheduler, encoder);
  const broadcaster = new Broadcaster(playout);
  encoder.on('data', chunk => broadcaster.onEncoded(chunk));

  const server = createServer(playout, broadcaster, importer);
  server.on('error', err => {
    logErr(`http server error: ${err.message}`);
    process.exit(1);
  });

  encoder.start();
  await playout.start();

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`${COLORS.green}Live radio running at http://localhost:${CONFIG.port}${CONFIG.mount}${COLORS.reset}`);
    console.log(`${COLORS.cyan}Songs dir:    ${CONFIG.songsDir} (${scheduler.songPool.length} songs)${COLORS.reset}`);
    console.log(`${COLORS.cyan}Playlist:     ${scheduler.active.join(', ')} — available: ${Object.entries(scheduler.playlistInfo().available).map(([n, c]) => `${n} (${c})`).join(', ')}${COLORS.reset}`);
    console.log(`${COLORS.cyan}Song intros:  ${CONFIG.songIntrosDir} (${scheduler.songIntroMap.size})${COLORS.reset}`);
    console.log(`${COLORS.cyan}Bumpers:      ${CONFIG.genericBumpersDir} (${scheduler.genericBumpers.length}, every ${CONFIG.bumperEvery} song(s))${COLORS.reset}`);
    console.log(`${COLORS.cyan}Encoder:      mp3 ${CONFIG.bitrate}k ${CONFIG.sampleRate}Hz, burst ${CONFIG.burstSeconds}s, normalize=${CONFIG.normalize ? 'on' : 'off'}${CONFIG.hls ? `, HLS at /hls/live.m3u8` : ''}${COLORS.reset}`);
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
      if (!parts.length) { const i = scheduler.playlistInfo(); return `active: ${i.active.join(', ')} — available: ${Object.entries(i.available).map(([n, c]) => `${n} (${c})`).join(', ')}`; }
      const now = parts[parts.length - 1].toLowerCase() === 'now';
      return playout.setPlaylist(parts[0], now);
    },
    playlists: () => commands.playlist(''),
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
    listeners: () => [...broadcaster.listeners].map(l => `${l.remote} (${Math.round((Date.now() - l.connectedAt) / 1000)}s)`).join(', ') || 'none',
    queue: () => playout.status().upcoming.join('\n') || '(queue empty)',
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
    process: () => { rawProcessor.scan(true).catch(e => logErr(e.message)); return `processing ${CONFIG.rawIntrosDir}`; },
    check: arg => {
      // check            bumpers + song intros
      // check all        + every song in every playlist
      // check <playlist> songs of that playlist only
      scheduler.refresh();
      const which = arg.trim().toLowerCase();
      let files;
      if (!which) files = [...scheduler.genericBumpers, ...scheduler.songIntroMap.values()];
      else if (which === 'all') files = [...scheduler.genericBumpers, ...scheduler.songIntroMap.values(), ...new Set([...scheduler.playlists.values()].flat())];
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
    help: () => 'commands: skip | play <song> [now] | seek +30 | seek 1:30 | now | queue | playlists | playlist <name> [now] | import <url> [folder] | imports | spotify | ytdlp | listeners | check [all|<playlist>] | intros | process | reload | stop',
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
