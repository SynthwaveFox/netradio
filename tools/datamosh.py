"""Datamosh bumpers: corrupt the MP3 bitstream, then chop the audio up.

Usage: python tools/datamosh.py IN [IN ...] [--out DIR] [--seed N] [--intensity 0..1]

IN can be files or folders (every .mp3 inside is processed).
Output goes to DIR (default intros/moshed) as moshed-<name>.mp3.

Two stages:
  1. Codec mosh: flips bytes inside MP3 frame payloads (headers left intact so
     the stream still decodes) -> real decoder smear, warble and chirps.
  2. Glitch edit: stutters, reversed slices, tape stops, pitch jumps,
     grain shuffles and bitcrush bursts at random spots.
"""
import argparse
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from hijack import SR, load, save

BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
RATES = [44100, 48000, 32000]


def frames(data):
    """Yield (offset, length, payload_start) for each MPEG-1 Layer III frame."""
    i = 0
    if data[:3] == b"ID3":
        i = 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9])
    while i + 4 < len(data):
        h = data[i:i + 4]
        if h[0] != 0xFF or (h[1] & 0xFE) != 0xFA:  # MPEG-1, Layer III
            i += 1
            continue
        br = BITRATES[h[2] >> 4] if (h[2] >> 4) < 15 else 0
        sr = RATES[(h[2] >> 2) & 3] if ((h[2] >> 2) & 3) < 3 else 0
        if not br or not sr:
            i += 1
            continue
        length = 144000 * br // sr + ((h[2] >> 1) & 1)
        mono = (h[3] >> 6) == 3
        crc = 0 if h[1] & 1 else 2
        yield i, length, i + 4 + crc + (17 if mono else 32)
        i += length


def codec_mosh(path, rng, intensity):
    data = bytearray(Path(path).read_bytes())
    fr = list(frames(data))
    hit = rng.random(len(fr)) < 0.15 + 0.5 * intensity
    # corrupt in clumps so the damage comes in bursts, not evenly smeared
    hit &= np.repeat(rng.random(len(fr) // 8 + 1) < 0.5, 8)[: len(fr)]
    for (off, length, payload), h in zip(fr, hit):
        if not h:
            continue
        end = min(off + length, len(data))
        for _ in range(rng.integers(1, 2 + int(4 * intensity))):
            p = rng.integers(payload, max(payload + 1, end))
            if p < len(data):
                data[p] ^= 1 << rng.integers(0, 8)
    fd, tmp = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    Path(tmp).write_bytes(data)
    try:
        raw = subprocess.run(
            ["ffmpeg", "-v", "quiet", "-err_detect", "ignore_err", "-i", tmp,
             "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
            capture_output=True,
        ).stdout
    finally:
        os.remove(tmp)
    x = np.nan_to_num(np.frombuffer(raw, dtype=np.float32).astype(np.float64))
    # decoder blowups can be huge; tame them without killing the character
    return np.tanh(x * 1.5) / 1.5


def resample(seg, factor):
    """Speed/pitch change by factor (2 = octave up, shorter)."""
    idx = np.arange(0, len(seg) - 1, factor)
    return np.interp(idx, np.arange(len(seg)), seg)


def stutter(x, s, rng):
    seg = x[s:s + int(rng.uniform(0.02, 0.09) * SR)].copy()
    reps = rng.integers(3, 9)
    return np.tile(seg, reps), len(seg)


def reverse(x, s, rng):
    n = int(rng.uniform(0.1, 0.35) * SR)
    return x[s:s + n][::-1].copy(), n


def tape_stop(x, s, rng):
    n = int(rng.uniform(0.25, 0.6) * SR)
    seg = x[s:s + n]
    speed = np.linspace(1.0, 0.05, len(seg)) ** 1.5
    pos = np.cumsum(speed)
    pos = pos[pos < len(seg) - 1]
    return np.interp(pos, np.arange(len(seg)), seg), n


def pitch_jump(x, s, rng):
    n = int(rng.uniform(0.15, 0.4) * SR)
    return resample(x[s:s + n], rng.choice([0.5, 0.75, 1.5, 2.0])), n


def grain_shuffle(x, s, rng):
    n = int(rng.uniform(0.2, 0.5) * SR)
    g = int(rng.uniform(0.015, 0.05) * SR)
    seg = x[s:s + n]
    grains = [seg[i:i + g] for i in range(0, len(seg), g)]
    rng.shuffle(grains)
    return np.concatenate(grains), n


def crush(x, s, rng):
    n = int(rng.uniform(0.15, 0.4) * SR)
    seg = x[s:s + n]
    hold = rng.integers(8, 30)
    levels = rng.integers(3, 8)
    out = np.repeat(seg[::hold], hold)[: len(seg)]
    return np.round(out * levels) / levels, n


GLITCHES = [stutter, stutter, reverse, tape_stop, pitch_jump, grain_shuffle, crush]


def glitch_edit(x, rng, intensity, glitches=GLITCHES):
    count = int(2 + 8 * intensity * len(x) / (4 * SR))
    starts = np.sort(rng.integers(0, max(1, len(x) - SR // 4), count))
    out, cursor = [], 0
    for s in starts:
        if s < cursor:
            continue
        fx = glitches[rng.integers(len(glitches))]
        seg, consumed = fx(x, s, rng)
        out += [x[cursor:s], seg]
        cursor = s + consumed
    out.append(x[cursor:])
    y = np.concatenate(out)
    # tiny fades at every splice would soften it; hard cuts ARE the look
    return y


def mosh(path, rng, intensity):
    x = codec_mosh(path, rng, intensity)
    if len(x) < SR // 2:  # decoder gave up; fall back to clean decode
        x = load(path)
    y = glitch_edit(x, rng, intensity)
    return 0.9 * y / max(np.max(np.abs(y)), 1e-9)


def inputs(paths):
    for p in map(Path, paths):
        yield from sorted(p.glob("*.mp3")) if p.is_dir() else [p]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("inp", nargs="+")
    ap.add_argument("--out", default=str(Path(__file__).parent.parent / "intros" / "moshed"))
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--intensity", type=float, default=0.6)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(a.seed)
    for f in inputs(a.inp):
        dest = out / f"moshed-{f.name}"
        save(str(dest), mosh(f, rng, a.intensity))
        print(dest)
