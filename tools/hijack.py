"""Make a bumper sound like the signal is being hijacked.

Usage: python tools/hijack.py IN.mp3 OUT.mp3 [--seed N] [--intensity 0..1]

Layers static, heterodyne whistles, mains buzz, FSK data bursts and
signal dropouts/stutters over the voice, ramping up toward the end.
Needs ffmpeg on PATH and numpy.
"""
import argparse
import subprocess

import numpy as np

SR = 44100


def load(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def save(path, x):
    x = np.clip(x, -1, 1).astype(np.float32)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "1", "-ar", str(SR), "-i", "-",
         "-ac", "2", "-b:a", "192k", path],
        input=x.tobytes(), check=True,
    )


def onepole_lp(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def bandpass(x, lo, hi):
    return onepole_lp(x, hi) - onepole_lp(x, lo)


def smooth_noise(rng, n, rate):
    """Slowly wandering random control signal in [0, 1]."""
    pts = rng.random(int(n / SR * rate) + 2)
    return np.interp(np.arange(n), np.linspace(0, n, len(pts)), pts)


def radio_voice(x):
    # AM-radio band limit + soft clip
    return np.tanh(2.0 * bandpass(x, 300, 3400))


def static(rng, n):
    hiss = bandpass(rng.standard_normal(n), 800, 7000) * 0.25
    crackle = np.zeros(n)
    idx = rng.integers(0, n, n // 400)
    crackle[idx] = rng.uniform(-1, 1, len(idx))
    crackle = onepole_lp(crackle, 3000) * 3
    return hiss + crackle


def whistle(rng, n):
    t = np.arange(n) / SR
    drift = smooth_noise(rng, n, 2)
    freq = 900 + 2600 * drift + 40 * np.sin(2 * np.pi * 5.5 * t)
    return 0.18 * np.sin(2 * np.pi * np.cumsum(freq) / SR)


def buzz(n):
    t = np.arange(n) / SR
    return 0.08 * sum(np.sin(2 * np.pi * 60 * k * t) / k for k in (1, 2, 3, 5, 7))


def data_burst(rng, length):
    """Modem-ish FSK chirp: random tones at a fixed baud rate."""
    baud = int(SR / 120)
    tones = rng.choice([1200, 1800, 2400, 3100], length // baud + 1)
    freq = np.repeat(tones, baud)[:length]
    return 0.3 * np.sign(np.sin(2 * np.pi * np.cumsum(freq) / SR)) * 0.6


def hijack(x, rng, intensity):
    n = len(x)
    pad = int(0.8 * SR)  # interference tail after the voice ends
    x = np.concatenate([x, np.zeros(pad)])
    n = len(x)
    t = np.arange(n) / n

    # interference ramps up across the clip, wobbling
    ramp = (0.25 + 0.75 * t ** 1.5) * (0.6 + 0.4 * smooth_noise(rng, n, 6)) * intensity

    voice = radio_voice(x)

    # signal fading: voice ducks while interference swells
    fade = 1 - 0.7 * ramp * smooth_noise(rng, n, 4)

    # dropouts: brief hard cuts of the voice
    gate = np.ones(n)
    for _ in range(int(3 + 6 * intensity)):
        s = rng.integers(int(0.15 * n), n - pad)
        gate[s:s + rng.integers(int(0.02 * SR), int(0.12 * SR))] = 0
    gate = onepole_lp(gate, 200)

    # stutters: repeat a tiny slice a few times (buffer glitch)
    for _ in range(int(1 + 3 * intensity)):
        s = rng.integers(int(0.2 * n), n - pad - SR // 4)
        seg = voice[s:s + int(rng.uniform(0.03, 0.07) * SR)].copy()
        reps = rng.integers(2, 5)
        end = min(s + len(seg) * reps, n)
        voice[s:end] = np.tile(seg, reps)[: end - s]

    # bitcrush bursts
    crushed = np.round(voice * 6) / 6
    crushed = np.repeat(crushed[::6], 6)[:n]
    crush_mask = (smooth_noise(rng, n, 8) > 1 - 0.35 * intensity).astype(float)
    crush_mask = onepole_lp(crush_mask, 80)
    voice = voice * (1 - crush_mask) + crushed * crush_mask

    out = voice * fade * gate

    noise = static(rng, n) * (0.15 + ramp)
    noise += whistle(rng, n) * ramp
    noise += buzz(n) * ramp

    # data bursts (the "someone else is on this frequency" moments)
    for _ in range(int(1 + 3 * intensity)):
        length = int(rng.uniform(0.15, 0.4) * SR)
        s = rng.integers(int(0.3 * n), n - length)
        noise[s:s + length] += data_burst(rng, length)
        out[s:s + length] *= 0.3

    # final takeover: everything collapses into a loud static/data blast
    tail = n - pad
    noise[tail:] += data_burst(rng, pad) * np.linspace(1, 0, pad)
    noise[tail:] += rng.standard_normal(pad) * 0.3 * np.linspace(1, 0, pad) ** 2

    mix = out + bandpass(noise, 150, 6000)
    return 0.9 * mix / np.max(np.abs(mix))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--intensity", type=float, default=0.7)
    a = ap.parse_args()
    save(a.out, hijack(load(a.inp), np.random.default_rng(a.seed), a.intensity))
