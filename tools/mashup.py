"""Mash several bumpers into one glitched clip, like stations bleeding together.

Usage: python tools/mashup.py [IN ...] [--pick N] [--count K] [--length S]
                              [--out DIR] [--seed N] [--intensity 0..1]

IN: files or folders (default intros/generic). Each output clip takes --pick
random bumpers, chops them into word-sized slices and splices them together
with hard cuts, reversed bits and overlapping "crosstalk" layers, then
runs datamosh's glitch edit (minus tape stops and pitch jumps) and MP3 bitstream corruption over the whole thing.
Writes K clips to DIR (default intros/mashed) as mashup-<n>.mp3.
"""
import argparse
import os
import tempfile
from pathlib import Path

import numpy as np

from datamosh import GLITCHES, codec_mosh, glitch_edit, inputs, pitch_jump, tape_stop
from hijack import SR, load, save

# no tape stops or pitch jumps: keep every voice at its natural speed
MASH_GLITCHES = [g for g in GLITCHES if g not in (tape_stop, pitch_jump)]


def trim_silence(x, thresh=0.01):
    loud = np.flatnonzero(np.abs(x) > thresh)
    return x[loud[0]:loud[-1]] if len(loud) else x


def slice_from(src, rng):
    # mostly word-sized chunks, occasionally a longer intelligible phrase
    n = int((rng.uniform(0.6, 1.4) if rng.random() < 0.2 else rng.uniform(0.08, 0.45)) * SR)
    s = rng.integers(0, max(1, len(src) - n))
    return src[s:s + n]


def mash(sources, rng, length, intensity):
    target = int(length * SR)
    out = np.zeros(target + 2 * SR)
    pos = 0
    while pos < target:
        seg = slice_from(sources[rng.integers(len(sources))], rng).copy()
        if rng.random() < 0.15:
            seg = seg[::-1]
        out[pos:pos + len(seg)] += seg
        # crosstalk: another bumper bleeding in underneath, quieter
        if rng.random() < 0.25 + 0.35 * intensity:
            bleed = slice_from(sources[rng.integers(len(sources))], rng)
            off = pos + rng.integers(0, max(1, len(seg)))
            out[off:off + len(bleed)] += 0.5 * bleed[: len(out) - off]
        # sometimes back up and overlap, sometimes leave a dead-air gap
        pos += len(seg) + int(rng.uniform(-0.05, 0.04 if rng.random() < 0.8 else 0.25) * SR)
        pos = max(pos, 0)
    y = trim_silence(out)
    return glitch_edit(y, rng, intensity, MASH_GLITCHES)


def codec_pass(x, rng, intensity):
    fd, tmp = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    try:
        save(tmp, 0.9 * x / max(np.max(np.abs(x)), 1e-9))
        y = codec_mosh(tmp, rng, intensity)
    finally:
        os.remove(tmp)
    return y if len(y) > SR // 2 else x


if __name__ == "__main__":
    root = Path(__file__).parent.parent / "intros"
    ap = argparse.ArgumentParser()
    ap.add_argument("inp", nargs="*", default=[str(root / "generic")])
    ap.add_argument("--pick", type=int, default=4, help="bumpers per clip")
    ap.add_argument("--count", type=int, default=5, help="clips to make")
    ap.add_argument("--length", type=float, default=7.0, help="target seconds")
    ap.add_argument("--out", default=str(root / "mashed"))
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--intensity", type=float, default=0.6)
    a = ap.parse_args()

    files = list(inputs(a.inp))
    rng = np.random.default_rng(a.seed)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for i in range(1, a.count + 1):
        chosen = rng.choice(files, min(a.pick, len(files)), replace=False)
        y = mash([trim_silence(load(str(f))) for f in chosen], rng, a.length, a.intensity)
        y = codec_pass(y, rng, a.intensity)
        dest = out / f"mashup-{i}.mp3"
        save(str(dest), 0.9 * y / max(np.max(np.abs(y)), 1e-9))
        print(dest, "<-", ", ".join(Path(f).stem for f in chosen))
