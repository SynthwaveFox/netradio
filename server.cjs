const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SONGS_DIR = process.env.SONGS_DIR || path.join(__dirname, 'songs');
const SONG_INTROS_DIR = process.env.SONG_INTROS_DIR || path.join(__dirname, 'intros', 'songs');
const GENERIC_BUMPERS_DIR = process.env.GENERIC_BUMPERS_DIR || path.join(__dirname, 'intros', 'generic');
const BITRATE = process.env.BITRATE || '192k';
const VOLUME = process.env.VOLUME || '0.75';

const ICECAST_HOST = process.env.ICECAST_HOST || '127.0.0.1';
const ICECAST_PORT = process.env.ICECAST_PORT || '8000';
const ICECAST_PASSWORD = process.env.ICECAST_PASSWORD || 'hackme';
const ICECAST_MOUNT = process.env.ICECAST_MOUNT || 'radio.mp3';
const ICECAST_NAME = process.env.ICECAST_NAME || 'Gizmo Radio';
const ICECAST_DESCRIPTION = process.env.ICECAST_DESCRIPTION || 'Node + ffmpeg + Icecast live radio';
const ICECAST_GENRE = process.env.ICECAST_GENRE || 'Mixed';
const ICECAST_PUBLIC = process.env.ICECAST_PUBLIC || '0';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus']);

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  if (!fileExists(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getAudioFilesRecursive(dir) {
  if (!fileExists(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAudioFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
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
    const artist = parts[0].trim();
    const title = parts.slice(1).join(' - ').trim();
    return { artist, title, base };
  }

  return { artist: '', title: base.trim(), base };
}

function pickRandom(array) {
  if (!array.length) return null;
  return array[Math.floor(Math.random() * array.length)];
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class RadioScheduler {
  constructor() {
    this.songPool = [];
    this.genericBumpers = [];
    this.songIntroMap = new Map();
    this.queue = [];
    this.lastSong = null;
    this.refresh();
    this.rebuildQueue();
  }

  refresh() {
    ensureDir(SONGS_DIR);
    ensureDir(SONG_INTROS_DIR);
    ensureDir(GENERIC_BUMPERS_DIR);

    this.songPool = getAudioFilesRecursive(SONGS_DIR);
    this.genericBumpers = getAudioFilesRecursive(GENERIC_BUMPERS_DIR);

    const introFiles = getAudioFilesRecursive(SONG_INTROS_DIR);
    this.songIntroMap = new Map(
      introFiles.map(file => [normalizeName(path.basename(file, path.extname(file))), file])
    );
  }

  rebuildQueue() {
    const shuffled = shuffle(this.songPool);

    if (shuffled.length > 1 && this.lastSong && shuffled[0] === this.lastSong) {
      const moved = shuffled.shift();
      shuffled.push(moved);
    }

    this.queue = shuffled;
  }

  findMatchingIntro(songPath) {
    const { artist, title, base } = parseSongInfo(songPath);
    const candidates = [];

    if (artist && title) {
      candidates.push(`${normalizeName(artist)}-${normalizeName(title)}`);
    }
    candidates.push(normalizeName(base));
    if (title) {
      candidates.push(normalizeName(title));
    }

    for (const candidate of candidates) {
      if (this.songIntroMap.has(candidate)) {
        return this.songIntroMap.get(candidate);
      }
    }

    return null;
  }

  getNextSong() {
    if (!this.queue.length) {
      this.refresh();
      this.rebuildQueue();
    }

    const next = this.queue.shift() || null;
    this.lastSong = next;
    return next;
  }

  getNextPlayoutItems() {
    const song = this.getNextSong();
    if (!song) return [];

    const items = [];
    const customIntro = this.findMatchingIntro(song);

    if (customIntro) {
      items.push(customIntro);
    } else {
      const generic = pickRandom(this.genericBumpers);
      if (generic) {
        items.push(generic);
      }
    }

    items.push(song);
    return items;
  }
}

function spawnIcecastFfmpeg(files) {
  const args = [];

  for (const file of files) {
  args.push('-re', '-i', file);
  }

  if (files.length === 1) {
    args.push('-filter:a', `volume=${VOLUME}`);
  } else {
    const concatInputs = files.map((_, i) => `[${i}:a]`).join('');
    args.push('-filter_complex', `${concatInputs}concat=n=${files.length}:v=0:a=1[outa0];[outa0]volume=${VOLUME}[outa]`);
    args.push('-map', '[outa]');
  }

  args.push(
    '-vn',
    '-content_type', 'audio/mpeg',
    '-f', 'mp3',
    '-acodec', 'libmp3lame',
    '-b:a', BITRATE,
    '-ice_name', ICECAST_NAME,
    '-ice_description', ICECAST_DESCRIPTION,
    '-ice_genre', ICECAST_GENRE,
    '-ice_public', ICECAST_PUBLIC,
    `icecast://source:${ICECAST_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}/${ICECAST_MOUNT}`
  );

  return spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

class IcecastRadio {
  constructor() {
    this.scheduler = new RadioScheduler();
    this.ffmpeg = null;
    this.currentFiles = [];
    this.startedAt = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.playNextSegment();
  }

  playNextSegment() {
    if (!this.running) return;

    const files = this.scheduler.getNextPlayoutItems();
    this.currentFiles = files;
    this.startedAt = new Date().toISOString();

    if (!files.length) {
      console.log('No songs found, waiting...');
      setTimeout(() => this.playNextSegment(), 1000);
      return;
    }

    console.log('Now streaming:', files.map(f => path.basename(f)).join(' -> '));
    this.ffmpeg = spawnIcecastFfmpeg(files);

    this.ffmpeg.stderr.on('data', chunk => {
      const text = chunk.toString();
      if (text.trim()) {
        console.log(text.trim());
      }
    });

    this.ffmpeg.on('close', () => {
      this.ffmpeg = null;
      if (this.running) {
        this.playNextSegment();
      }
    });

    this.ffmpeg.on('error', err => {
      this.ffmpeg = null;
      console.error('ffmpeg process error:', err.message);
      if (this.running) {
        setTimeout(() => this.playNextSegment(), 1000);
      }
    });
  }
}

const radio = new IcecastRadio();
radio.start();

console.log('Icecast radio playout started.');
console.log(`Target stream: http://${ICECAST_HOST}:${ICECAST_PORT}/${ICECAST_MOUNT}`);
console.log(`Songs dir: ${SONGS_DIR}`);
console.log(`Song intros dir: ${SONG_INTROS_DIR}`);
console.log(`Generic bumpers dir: ${GENERIC_BUMPERS_DIR}`);
console.log('Requires ffmpeg in PATH and Icecast running.');
