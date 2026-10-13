"""Generate power-cut / power-down sound effects.

Usage: python tools/powerdown.py [--out DIR] [--seed N]

Writes five variants to DIR (default intros/sfx):
  powerdown-cut.mp3     sudden: breaker clunk, spark, hum dies fast
  powerdown-spin.mp3    slow: hum and whine wind down like a dying transformer
  powerdown-radio.mp3   on-air: static spike, relay click, carrier collapses to dead air
  powerdown-industrial.mp3  contactor slam, air dump, big rotor whirs down, knocks, clanks to a stop
  powerdown-abrupt.mp3      same, but starts on the slam (no lead-in) with a 4 s whir-down
"""
import argparse
from pathlib import Path

import numpy as np

from hijack import SR, bandpass, onepole_lp, save


def t_axis(sec):
    return np.arange(int(sec * SR)) / SR


def spindown_hum(sec, tau, base=60, whine=4200, rng=None):
    """Mains buzz + coil whine whose pitch and level fall away together."""
    t = t_axis(sec)
    speed = np.exp(-t / tau)
    phase = 2 * np.pi * np.cumsum(speed) / SR
    hum = sum(np.sin(base * k * phase) / k for k in (1, 2, 3, 4, 5, 7, 9))
    hum = np.tanh(1.8 * hum)  # transformer buzz is gritty, not pure
    coil = 0.15 * np.sin(whine * phase)
    level = speed ** 1.4
    return (0.35 * hum + coil) * level


def clunk(rng):
    """Breaker / relay thunk: click transient + low body thump."""
    t = t_axis(0.35)
    click = rng.standard_normal(len(t)) * np.exp(-t / 0.004)
    body = np.sin(2 * np.pi * (55 * t + 40 * (1 - np.exp(-t / 0.03)) * 0.03)) * np.exp(-t / 0.08)
    return 0.9 * onepole_lp(click, 5000) + 0.8 * body


def spark(rng, sec=0.25):
    """Short electrical arc: dense crackle that thins out."""
    t = t_axis(sec)
    density = np.exp(-t / (sec / 3))
    pops = (rng.random(len(t)) < 0.02 * density) * rng.uniform(-1, 1, len(t))
    hiss = rng.standard_normal(len(t)) * 0.3 * density
    return bandpass(pops * 4 + hiss, 1500, 9000)


def thump_down(sec=0.6):
    """Speaker cone dropping as the amp's caps drain: low pitch sweep."""
    t = t_axis(sec)
    freq = 20 + 70 * np.exp(-t / 0.12)
    return 0.6 * np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t / 0.2)


def place(buf, x, at):
    s = int(at * SR)
    end = min(len(buf), s + len(x))
    buf[s:end] += x[: end - s]


def cut(rng):
    out = np.zeros(int(2.0 * SR))
    place(out, spindown_hum(0.25, 1e9), 0)  # steady hum while running...
    place(out, clunk(rng), 0.25)
    place(out, spark(rng, 0.18), 0.25)
    place(out, spindown_hum(1.2, 0.18), 0.25)  # ...and it drops out
    place(out, thump_down(), 0.27)
    return out


def spin(rng):
    out = np.zeros(int(4.0 * SR))
    place(out, spindown_hum(3.6, 0.9, whine=6000), 0)
    place(out, 0.4 * clunk(rng), 0.05)
    place(out, thump_down(0.9), 1.2)
    return out


def radio(rng):
    out = np.zeros(int(2.5 * SR))
    t = t_axis(0.5)
    static = bandpass(rng.standard_normal(len(t)), 400, 6000) * 0.5
    place(out, static * np.linspace(0.3, 1.0, len(t)), 0)  # signal flaring up
    place(out, 0.7 * spark(rng, 0.12), 0.45)
    place(out, clunk(rng) * 0.8, 0.5)
    # carrier tone collapsing as the transmitter loses power
    place(out, 0.25 * spindown_hum(0.8, 0.12, base=120, whine=2400), 0.5)
    # faint residual hiss trailing into dead air
    tail = t_axis(1.8)
    place(out, 0.06 * bandpass(rng.standard_normal(len(tail)), 800, 5000) * np.exp(-tail / 0.35), 0.52)
    return out


# --- industrial: big rotating machine losing power -------------------------

def fftconv(x, h):
    n = len(x) + len(h) - 1
    size = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(h, size), size)[:n]


def metal_ir(rng, sec=1.2, partials=(173, 412, 689, 1031, 1544, 2207, 3170)):
    """Struck steel: inharmonic modes, higher ones dying faster."""
    t = t_axis(sec)
    ir = np.zeros(len(t))
    for f in partials:
        f *= rng.uniform(0.97, 1.03)
        ir += np.sin(2 * np.pi * f * t) * np.exp(-t * (2 + f / 300)) * rng.uniform(0.4, 1)
    return ir / np.max(np.abs(ir))


def hall_ir(rng, sec=2.2):
    """Big concrete/steel room: dark noise tail."""
    t = t_axis(sec)
    return onepole_lp(rng.standard_normal(len(t)), 2500) * np.exp(-t / 0.55) * 0.08


def slam(rng):
    """Contactor bank dropping out: hard impact into ringing steel."""
    hit = np.zeros(int(0.02 * SR))
    hit[:40] = rng.uniform(-1, 1, 40)
    ring = fftconv(hit, metal_ir(rng, 1.5))
    t = t_axis(0.4)
    thud = np.sin(2 * np.pi * np.cumsum(30 + 60 * np.exp(-t / 0.05)) / SR) * np.exp(-t / 0.12)
    out = 0.5 * ring / np.max(np.abs(ring))
    out[: len(thud)] += thud
    return out


def air_release(rng, sec=1.4):
    """Pneumatic/hydraulic pressure dump: pssshhh."""
    t = t_axis(sec)
    env = np.minimum(t / 0.02, 1) * np.exp(-t / 0.4)
    return bandpass(rng.standard_normal(len(t)), 2500, 9000) * env * 0.5


def machine(rng, sec, run=1.0, rot=29.0, blades=9, teeth=37):
    """Rotor + gearbox + bearings, spinning down to a stop over sec - run."""
    t = t_axis(sec)
    down = np.clip((t - run) / (sec - run), 0, 1)
    speed = (1 - down) ** 1.7  # coasts, then friction drags it to a halt
    rot_phase = 2 * np.pi * rot * np.cumsum(speed) / SR

    # blade-pass drone with gritty harmonics
    drone = sum(np.sin(blades * k * rot_phase + rng.uniform(0, 6)) / k for k in range(1, 7))
    drone = np.tanh(1.5 * drone)
    # gear-mesh whine, slightly detuned pair for that sour beating
    whine = np.sin(teeth * rot_phase) + 0.6 * np.sin(teeth * 1.004 * rot_phase)
    # rotor imbalance: low wobble at the shaft rate
    wobble = np.sin(rot_phase) + 0.4 * np.sin(2 * rot_phase)
    # bearings: grinding noise, pulsing once per revolution
    grind = bandpass(rng.standard_normal(len(t)), 300, 3000)
    grind *= 0.6 + 0.4 * np.sin(rot_phase) ** 2

    y = (0.35 * drone * speed ** 0.8
         + 0.12 * whine * speed ** 1.5
         + 0.4 * wobble * speed ** 0.5
         + 0.25 * grind * speed ** 0.7)

    # loose part knocking once per revolution, louder as it slows down
    knocks = np.zeros(len(t))
    rev = np.flatnonzero(np.diff(np.floor(rot_phase / (2 * np.pi))) > 0)
    for i in rev:
        sp = speed[i]
        if 0.02 < sp < 0.45:
            knocks[i] = (0.45 - sp) * rng.uniform(1.2, 2.2)
    y += 0.6 * fftconv(knocks, metal_ir(rng, 0.25, (310, 745, 1390, 2280)))[: len(t)]
    return y, speed


def industrial(rng, lead=1.0, coast=7.0):
    """lead: seconds of machine running before the cut; coast: whir-down time."""
    out = np.zeros(int((lead + coast + 1.0) * SR))
    mach, speed = machine(rng, lead + coast, run=lead)
    place(out, mach, 0)
    place(out, 0.9 * slam(rng), lead)
    place(out, 0.5 * spark(rng, 0.3), lead)
    place(out, spindown_hum(1.5, 0.15), lead)  # mains buzz dies at the slam
    place(out, air_release(rng), lead + 0.15)
    # final settle: shaft stops and the housing clanks once
    stop = lead + np.argmax(speed[int(lead * SR):] < 0.01) / SR
    place(out, 0.35 * slam(rng), stop)
    # everything rings out in a big steel room
    wet = fftconv(out, hall_ir(rng))[: len(out)]
    return out + wet


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).parent.parent / "intros" / "sfx"))
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(a.seed)
    for name, fn in [("cut", cut), ("spin", spin), ("radio", radio), ("industrial", industrial),
                     ("abrupt", lambda r: industrial(r, lead=0.0, coast=4.0))]:
        y = fn(rng)
        dest = out / f"powerdown-{name}.mp3"
        save(str(dest), 0.9 * y / np.max(np.abs(y)))
        print(dest)
