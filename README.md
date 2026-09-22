# radio-server

Live netradio for a VRChat world. Three flavours live in this folder:

| File | What it is | Needs |
|---|---|---|
| `netradio.js` | **Self-contained live stream server** (recommended). One shared playhead, HLS + Icecast-style MP3, now-playing JSON. | Node 18+, ffmpeg + ffprobe on PATH |
| `importer.mjs` | optional add-on: import Spotify/YouTube playlists into `songs/<folder>` | yt-dlp (auto-downloaded) |
| `server.cjs` | Older playout that pushes into a separate Icecast server | Node, ffmpeg, Icecast |
| `radio.liq` | Liquidsoap playout into Icecast (WSL) | Liquidsoap, Icecast |

## Why this is "synced" and a file server is not

A file server hands every client its own copy of a file, so every client has its own
playhead — everyone hears a different song at a different moment. `netradio.js` has
exactly **one** playhead on the server: a single real-time encoder produces one MP3
byte stream, and every connected listener is fed the same bytes as they are produced
(plus a ~2 s "burst" of the most recent audio so players start instantly). That is the
same model Icecast/SHOUTcast use. Late joiners land at the live edge; all listeners are
within a couple of seconds of each other (their own player buffer is the only difference).

## Folders

```
songs/            music library (mp3/flac/wav/m4a/aac/ogg/opus)
songs/<name>/     a playlist named <name> (scanned recursively); loose files in songs/ = "default"
intros/songs/     optional song-specific intros, named like the song: "artist-title.mp3"
intros/generic/   generic bumpers, one is played before songs (see BUMPER_EVERY)
intros/raw/             unprocessed bumpers: echo effect + gain     → intros/generic/
intros/raw/clean/       gain only (no echo)                         → intros/generic/
intros/raw/songs/       unprocessed song intros: echo + gain        → intros/songs/
intros/raw/songs/clean/ gain only                                   → intros/songs/
```

All folders are rescanned before every playout block, so files added or removed over
SFTP take effect at the next break without a restart (`library changed: …` in the log).

### Playlists

Every sub-folder of `songs/` is a playlist; files sitting directly in `songs/` are the
`default` playlist. `PLAYLIST=` in `.env` picks the one to start with (`default`, a folder
name, `all`, or a comma list like `retro,synth`). Switch at runtime with the console:

```
playlists                 list playlists with song counts, show the active one
playlist retro            switch after the current song finishes
playlist retro now        switch immediately
playlist retro,synth      play a merge of several
playlist all              play everything
```

or `POST /playlist?token=…&name=retro[&now=1]`. `/now.json` reports `playlist.active` and
`playlist.available`. A switch reshuffles from the new pool and drops whatever was queued
from the old one. Switches are not persisted: a restart goes back to `PLAYLIST` from `.env`.
If the selected playlist does not exist or is empty, everything is played (with a warning)
rather than going silent.

### Importing playlists (Spotify / YouTube) — optional

Lives in `importer.mjs`. Upload it next to `netradio.js` to enable; leave it out and the
server runs identically minus the `import` command (no extra keys, no yt-dlp).

```
import <spotify or youtube playlist url> [folder] [max tracks]
imports                                   progress of the running import
ytdlp                                     update yt-dlp
```

`import https://open.spotify.com/playlist/... retro` reads the playlist, looks each track up
on YouTube Music (the audio-only "songs" results), verifies title and duration (±12 s),
downloads it with yt-dlp as 192k mp3 tagged with the playlist's artist/title, and drops it
into `songs/retro/` — where it is live immediately. Tracks already in the folder are skipped,
so re-running an import after you add songs to the Spotify playlist only fetches the new
ones. Tracks with no confident match are listed in `songs/<folder>/import-misses.txt` rather
than guessed. YouTube / YouTube Music playlist URLs work too (no matching needed). Same over
HTTP: `POST /import?token=…&url=…&folder=…[&limit=N]`.

- **Spotify, no setup:** playlists are read from the public embed page. No keys, but it lags
  playlist edits (minutes to hours) and stops at 100 tracks. Playlist must be public.
- **Spotify, live:** Spotify no longer gives app-only tokens playlist contents, so the live
  path needs a one-time login with *your* account:
  1. developer.spotify.com/dashboard → Create app → Web API, redirect URI **exactly**
     `https://<your PUBLIC_URL>/spotify/callback`.
  2. `.env`: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `PUBLIC_URL`, `ADMIN_TOKEN`. Restart.
  3. Open `https://<PUBLIC_URL>/spotify/login?token=<ADMIN_TOKEN>` in a browser, approve.
     The refresh token is saved to `spotify-auth.json` next to the server (keep it private).
  `spotify` in the console shows which mode is active. Falls back to the embed if the API fails.
- yt-dlp: found on PATH or in `bin/`; if missing, the official release is downloaded into
  `bin/` on first use (needs python3, which the Node.js egg image has). `ytdlp` updates it.
- If YouTube blocks the server's IP ("Sign in to confirm you're not a bot"), export cookies
  from a logged-in browser to a file and set `YTDLP_COOKIES=/home/container/cookies.txt`.
- Downloads run one at a time at low priority; expect ~10 s per track.

### Song-specific intros (`intros/songs/`)

A "coming up next…" clip for one song. Name the file like the song — `Artist - Title.mp3`
(exactly what imports produce) or just `Title.mp3`; matching ignores case, punctuation and
spacing, so `owl-city-fireflies.mp3` matches `songs/retro/Owl City - Fireflies.mp3` in any
playlist. When a song has an intro it plays instead of a generic bumper, regardless of
`BUMPER_EVERY`. Record them raw and drop them in `intros/raw/songs/` (or `…/songs/clean/`)
to get the same processing as bumpers.

`intros` in the console reports coverage (`12/40 songs covered`), writes the songs that still
need one to `intros/songs/missing-intros.txt`, and flags intro files that match no song
(usually a typo in the name).

### Bumper processing (`intros/raw/`)

Anything dropped into `intros/raw/` is processed by the server's ffmpeg and written to
`intros/generic/<name>.mp3`; the original moves to `intros/raw/done/`. Processing =

1. the station's "radio voice" effect: Audacity **Echo, delay 0.01 s, decay 0.5**
   (a 10 ms feedback comb — reproduced exactly as a 12-tap `aecho`), then
2. peak-normalise to `PROCESS_PEAK_DB` (default -1 dB).

Files dropped into `intros/raw/clean/` skip step 1 and are only normalised — for clips that
should sound clean (sponsor reads, music stings). They land in the same `intros/generic/`
pool and rotate randomly with the rest.

A file is only picked up once its size has stopped changing, so an in-progress upload is
safe. `process` in the console forces an immediate pass. Do **not** put already-processed
bumpers in `raw/` — they would get the effect twice.

| Var | Default | |
|---|---|---|
| `RAW_INTROS_DIR` | `intros/raw` | |
| `RAW_CLEAN_INTROS_DIR` | `intros/raw/clean` | gain-only source folder |
| `PROCESS_ECHO_DELAY_MS` / `PROCESS_ECHO_DECAY` | `10` / `0.5` | the Audacity Echo settings |
| `PROCESS_PEAK_DB` | `-1` | normalisation target |

Song ↔ intro matching is by normalised file name (`Katy Perry - Firework.mp3` matches
`katy-perry-firework.mp3`, `firework.mp3`, ...). Songs prefer embedded ID3 title/artist
tags; otherwise `Artist - Title.ext` is parsed from the file name.

## Run

```bash
npm start
```

Then:

| URL | |
|---|---|
| `http://host:3722/hls/live.m3u8` | **HLS stream — this is the URL for the VRChat video player** |
| `http://host:3722/radio.mp3` | live MP3 stream (Icecast-style) for browsers, VLC, foobar, etc. |
| `http://host:3722/` | tiny web player / now-playing page |
| `http://host:3722/now.json` | current track, position, duration, next up, listener count |
| `http://host:3722/history.json` | last 50 tracks |
| `POST /skip?token=…` | skip current track (needs `ADMIN_TOKEN`) |
| `POST /play?token=…&q=fireflies[&now=1]` | queue / play a specific song |
| `POST /seek?token=…&by=30` / `&by=-10` / `&to=90` | seek within the current track, relative or absolute seconds |
| `POST /reload?token=…` | rescan the library |

Console commands (type into the Pterodactyl console or the terminal):

| | |
|---|---|
| `skip` | next track |
| `play <song>` / `play <song> now` | queue a specific song next (with its intro/bumper) or cut to it now; matches any words in the file name across all playlists, lists candidates if ambiguous |
| `seek +30` / `seek -10` | jump forward / back within the current track |
| `seek 90` / `seek 1:30` | jump to an absolute position |
| `now` | current track, position, next up, listener count |
| `playlists` / `playlist <name> [now]` | list / switch playlists (see Playlists) |
| `import <url> [folder] [max]` / `imports` / `spotify` / `ytdlp` | import a Spotify/YouTube playlist into `songs/<folder>` (see Importing) |
| `intros` | song-intro coverage report + `missing-intros.txt` |
| `process` | process everything in `intros/raw/` now |
| `check` / `check all` / `check <playlist>` | full test-decode of bumpers+intros / everything in every playlist / one playlist's songs; reports FAIL with the decoder error |
| `queue`, `listeners`, `reload`, `stop`, `help` | |

Seeking restarts that track's decoder at the new position; listeners hear a clean cut
(no reconnect). Seeking past the end skips to the next track.

The stream endpoint answers `HEAD`, sends `Content-Type: audio/mpeg`, `icy-*` headers,
`Accept-Ranges: none`, no `Content-Length`, no chunked encoding, and supports
`Icy-MetaData: 1` (StreamTitle every 16000 bytes) — so VLC/foobar/browsers/yt-dlp all
treat it as a proper Icecast mount.

## Config (environment variables)

| Var | Default | |
|---|---|---|
| `PORT` / `HOST` | `3722` / `0.0.0.0` | |
| `MOUNT` | `/radio.mp3` | stream path (`/stream` and `/live` are aliases) |
| `PUBLIC_URL` | | e.g. `https://radio.example.com` — used in `/now.json` and the page |
| `SONGS_DIR`, `SONG_INTROS_DIR`, `GENERIC_BUMPERS_DIR` | see above | |
| `BITRATE` | `192` | MP3 kbps (CBR) |
| `BUMPER_EVERY` | `1` | generic bumper before every Nth song; `0` = never (song-specific intros always play) |
| `PLAYLIST` | `default` | playlist folder(s) to start with: a name, `all`, or `a,b` |
| `NORMALIZE` | `1` | loudness alignment per track: each file's integrated loudness is measured once (cached in `loudness-cache.json`) and ONE fixed gain is applied for the whole track. No compression or gain riding — dynamics within a song are untouched. `0` to disable |
| `NORMALIZE=peak` | | alternative: align every track's true peak to `NORMALIZE_PEAK` instead of its loudness. Simpler, but a dynamic voice clip and a compressed song at the same peak differ a lot in perceived volume |
| `NORMALIZE_TARGET` | `-16` | target LUFS (loudness mode) |
| `NORMALIZE_PEAK` | `-1` | true-peak ceiling in dBTP; a quiet track with big peaks gets less gain rather than clipping |
| `BUMPER_OFFSET_DB` | `-3` | bumpers and song intros are levelled this many dB below the songs |
| `VOLUME` | `1` | extra linear gain |
| `BURST_SECONDS` | `8` | audio sent instantly to a new listener. This is the player's cushion against jitter; every listener starts from the beginning of it, so it delays everyone equally and does not loosen sync. Too small (< 5) makes AVPro stutter and re-sync a few seconds in |
| `STATION_NAME`, `STATION_DESCRIPTION`, `STATION_GENRE` | Gizmo Radio… | icy headers |
| `ADMIN_TOKEN` | | enables `/skip` and `/reload` |
| `HLS` | `1` | also encodes an AAC HLS stream into `hls/` and serves `/hls/live.m3u8`. `0` disables |
| `HLS_BITRATE`, `HLS_SEGMENT_SECONDS` | `128`, `4` | |
| `HLS_WINDOW_SEGMENTS` | `6` | playlist length (x segment seconds). AVPro starts at the first listed segment, so this is the tune-in delay behind the server — keep it small |
| `HLS_KEEP_SEGMENTS` | `15` | expired segments kept on disk so a player that fell behind can still fetch them instead of jumping |

Settings can also go in a `.env` file next to `netradio.js` (see `.env.example`);
real environment variables take precedence. `PORT` falls back to `SERVER_PORT`, which is
what Pterodactyl sets from the allocation.

PowerShell example:

```powershell
$env:STATION_NAME="Fennia FM"; $env:ADMIN_TOKEN="changeme"; $env:HLS="1"; node netradio.js
```

## Deploying on Pterodactyl (Node.js egg)

1. Create a server with the generic **Node.js** egg (same as the music CDN). 512 MB RAM is
   plenty (two ffmpeg processes + node ≈ 150 MB). Pick a Node 18+ image.
2. Egg variables: `MAIN_FILE` = `netradio.js`. Leave `NODE_PACKAGES` empty (no deps).
   **Only one `*.js` file may sit in the container root** — the egg's start script does
   `[[ "$MAIN_FILE" == *.js ]]` and the glob expands if there are more (that is why the
   optional importer is `.mjs`).
3. Upload via SFTP (panel → Settings → SFTP details):
   - `netradio.js`, `package.json`
   - `songs/`, `intros/generic/`, `intros/songs/`
   - `.env` (copy `.env.example`, set `STATION_NAME`, `ADMIN_TOKEN`, `PUBLIC_URL`)
4. Start. The console should print `Live radio running at http://localhost:<port>/radio.mp3`
   with the allocation port. If it says it cannot run ffmpeg, the image lacks it: drop a
   static Linux build (johnvansickle.com/ffmpeg) into `bin/`, `chmod +x` them via SFTP, and
   set `FFMPEG_PATH=/home/container/bin/ffmpeg` and `FFPROBE_PATH=/home/container/bin/ffprobe`
   in `.env`. The parkervcp `yolks:nodejs_*` images ship ffmpeg, so this is normally not needed.
5. Open `http://<node-ip>:<port>/` in a browser and press play. Check `/now.json`.

## Testing that it is actually in sync

1. **Browser + VLC on the same PC**: open the web page in a browser and the stream URL in
   VLC (Media → Open Network Stream). Start them a few seconds apart; both should be on the
   same track within ~2–3 s of each other. VLC shows the StreamTitle metadata.
2. **`/now.json` is the source of truth**: its `position` is the server playhead. Any
   listener should be at `position` minus a couple of seconds.
3. **VRChat**: paste `http://<node-ip>:<port>/radio.mp3` into the world's AVPro player
   (enable "Allow Untrusted URLs" while testing on a bare IP). Have a second person join, or
   join from a second account/instance — everyone should hear the same moment of the same
   song. Compare against `/now.json` if in doubt.
4. Once it works, put it behind the same domain/TLS as the CDN so Quest users (https only)
   can tune in, then set `PUBLIC_URL` accordingly.

## VRChat notes

- **Use the HLS URL in the world**: `https://your-domain/hls/live.m3u8`. Tested: the raw
  MP3 stream plays fine in browsers/VLC, but AVPro on PC (Media Foundation) stutters a few
  seconds in and then audibly re-syncs on a progressive MP3 stream; HLS plays cleanly.
  HLS is also what Quest prefers, and it needs **https**.
- Same rules as your music CDN: the domain must be on VRChat's allow list or users need
  "Allow Untrusted URLs".
- Because it is a live source, the world script does not need to sync a timestamp —
  just make everyone load the same URL. That is what keeps the room together.
- HLS listeners sit roughly `HLS_WINDOW_SEGMENTS × 4` s (~24 s) behind the server playhead
  (`/now.json` position). It is the same for everyone in the instance, so it does not affect
  sync between players.
- Any ordinary reverse proxy (nginx defaults included) works: HLS is just small HTTP files.
  `proxy_buffering off` on the MP3 mount only matters if you want the raw MP3 stream to
  behave exactly like Icecast for picky players; it is not needed for VRChat.

## Behaviour details

- Track changes are gapless; the encoder never restarts between tracks, so listeners
  never reconnect.
- If the library is empty or a decoder underruns, the timeline is padded with silence
  rather than stalling — the stream never drops.
- Slow listeners (over 1 MB of unsent data) are disconnected instead of stalling everyone.
- If the machine sleeps, lost time is skipped instead of being burst-sent on wake.
