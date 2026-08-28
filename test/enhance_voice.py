#!/usr/bin/env python3
"""
enhance_voice.py -- "Enhance voice" pipeline for a single audio file.

Stage order (this order is the whole trick):
  1. decode -> 48 kHz mono float32
  2. de-plosive      (time-varying LF suppression, surgical)
  3. de-click        (transient detect + LPC interpolation, surgical)
  4. neural denoise + dereverb   (DeepFilterNet3 or MossFormer2_SE_48K)
  5. polish chain via ffmpeg: HPF -> de-ess -> EQ -> compress -> limit -> loudnorm

Surgical repairs go BEFORE the network: clicks and plosives are impulsive and
out-of-distribution for models trained on additive noise, and a network will
smear them across neighbouring frames instead of removing them. Dynamics and
loudness go AFTER: the network output has arbitrary gain.

usage:
    python enhance_voice.py audio.mp3 -o out.wav
    python enhance_voice.py audio.mp3 -o out.wav --backend clearvoice --lufs -14
    python enhance_voice.py audio.mp3 -o out.wav --backend none   # DSP only
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from scipy import signal as sps
from scipy.linalg import toeplitz

SR = 48000


# ---------------------------------------------------------------- io helpers

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{p.stderr[-4000:]}")
    return p.stderr


def decode(path, sr=SR):
    """Decode anything ffmpeg understands to mono float32 at `sr`."""
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le",
         "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(sr), "-"],
        capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"decode failed:\n{p.stderr.decode()[-4000:]}")
    return np.frombuffer(p.stdout, dtype="<f4").astype(np.float64)


def write_wav(x, path, sr=SR):
    x = np.clip(x, -1.0, 1.0).astype("<f4")
    p = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "f32le", "-ar", str(sr),
         "-ac", "1", "-i", "pipe:0", "-c:a", "pcm_f32le", path],
        input=x.tobytes(), capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"write failed:\n{p.stderr.decode()[-4000:]}")


# ------------------------------------------------------------- 2. de-plosive

def deplosive(x, sr=SR, lo=20.0, hi=120.0, thresh_db=9.0, floor_db=-24.0):
    """
    Plosives are short bursts of energy below ~120 Hz that are far louder than
    the speech band. Detect frames where the LF/mid energy ratio spikes above
    its own running median, then duck only the LF band over those frames with
    a smooth gain envelope. This is a dynamic high-pass, not a static one --
    a static HPF steep enough to kill a pop also thins every voiced sound.
    """
    n = 1024
    hop = n // 4
    win = sps.get_window("hann", n, fftbins=True)
    f, t, Z = sps.stft(x, sr, window=win, nperseg=n, noverlap=n - hop,
                       boundary="zeros", padded=True)
    mag2 = (np.abs(Z) ** 2) + 1e-20

    lf = (f >= lo) & (f < hi)
    mid = (f >= 300) & (f < 3500)
    ratio_db = 10 * np.log10(mag2[lf].sum(0) / mag2[mid].sum(0))

    # running median baseline over ~2 s, so a steady rumble is not treated as
    # a plosive but a sudden burst is
    k = max(3, int(2.0 * sr / hop) | 1)
    base = sps.medfilt(ratio_db, kernel_size=min(k, len(ratio_db) - (1 - len(ratio_db) % 2)))
    excess = ratio_db - base

    # soft knee: 0 dB duck at threshold, floor_db at threshold+12
    duck_db = np.clip((excess - thresh_db) / 12.0, 0.0, 1.0) * floor_db
    # widen + smooth so the gain moves over ~15 ms, avoiding zipper artefacts
    w = max(3, int(0.015 * sr / hop) | 1)
    duck_db = sps.medfilt(duck_db, kernel_size=3)
    duck_db = np.convolve(duck_db, np.hanning(w) / np.hanning(w).sum(), mode="same")

    gain = 10 ** (duck_db / 20.0)
    # taper the gain across frequency so the cut fades out by `hi`
    prof = np.ones_like(f)
    band = (f >= lo) & (f <= hi * 1.5)
    prof[band] = np.clip((hi * 1.5 - f[band]) / (hi * 1.5 - lo), 0, 1)
    prof[f < lo] = 1.0

    G = 1.0 + (gain[None, :] - 1.0) * prof[:, None]
    _, y = sps.istft(Z * G, sr, window=win, nperseg=n, noverlap=n - hop)
    return y[: len(x)], int((duck_db < -1.0).sum())


# --------------------------------------------------------------- 3. de-click

def _lpc(x, order):
    """Autocorrelation-method LPC. Returns a with a[0] == 1."""
    x = np.asarray(x, dtype=np.float64)
    if len(x) < order * 2:
        return None
    r = np.correlate(x, x, "full")[len(x) - 1: len(x) + order]
    if r[0] <= 0:
        return None
    r = r.copy()
    r[0] *= 1.0 + 1e-4          # ridge, keeps the Toeplitz solve stable
    try:
        a = np.linalg.solve(toeplitz(r[:order]), r[1: order + 1])
    except np.linalg.LinAlgError:
        return None
    return np.concatenate(([1.0], -a))


def _repair(x, s, e, order=32, ctx=1536):
    """
    Replace x[s:e] with the least-squares AR interpolation given surrounding
    context (Janssen/Vaseghi). Minimises LPC residual energy over the gap, so
    the fill inherits the local formant structure instead of being a straight
    line or a fade.
    """
    l0, r1 = max(0, s - ctx), min(len(x), e + ctx)
    context = np.concatenate([x[l0:s], x[e:r1]])
    a = _lpc(context, order)
    if a is None:
        # Degenerate context: the gap sits in (near-)silence, where LPC is
        # undefined. The correct fill there is the silence itself, reached with
        # a raised-cosine ramp so the repair introduces no step discontinuity.
        n = e - s
        ramp = 0.5 * (1 + np.cos(np.linspace(0, np.pi, n)))
        edge = (x[s - 1] if s > 0 else 0.0)
        x[s:e] = edge * ramp
        return True

    n0, n1 = max(0, s - order), min(len(x), e + order)
    seg = x[n0:n1].copy()
    N, rows = len(seg), len(seg) - order
    if rows <= 0:
        return False

    A = np.zeros((rows, N))
    ar = a[::-1]
    for i in range(rows):
        A[i, i: i + order + 1] = ar

    unk = np.arange(s - n0, e - n0)
    kn = np.setdiff1d(np.arange(N), unk)
    try:
        sol, *_ = np.linalg.lstsq(A[:, unk], -A[:, kn] @ seg[kn], rcond=None)
    except np.linalg.LinAlgError:
        return False
    if not np.all(np.isfinite(sol)):
        return False

    seg[unk] = sol
    x[n0:n1] = seg
    return True


def _smooth_env(x, sr, ms):
    w = max(3, int(ms * 1e-3 * sr))
    k = np.ones(w) / w
    return np.sqrt(np.convolve(x * x, k, mode="same") + 1e-20)


def declick(x, sr=SR, sens=8.0, max_ms=2.5, gate_db=-22.0):
    """
    Mouth clicks are wideband transients of a few hundred microseconds to ~2 ms.
    Two things make detection hard:

      * the LPC residual of voiced speech is *already* full of large spikes --
        those are glottal pulses, and a naive threshold shreds them;
      * real clicks are audible mostly because they sit in quiet passages
        (breath gaps, pre-onset silence), where nothing masks them.

    So detection is gated to frames whose broadband level sits `gate_db` below
    the running speech level, and inside those frames we threshold the
    high-band LPC residual against a robust local scale. Repair is by AR
    interpolation, not gating -- muting a click leaves an audible hole.
    """
    x = x.copy()
    slow = _smooth_env(x, sr, 25.0)
    speech_level = np.percentile(slow, 90)
    if speech_level <= 0:
        return x, 0
    quiet = slow < speech_level * 10 ** (gate_db / 20.0)
    if not quiet.any():
        return x, 0

    b, a = sps.butter(4, 2500 / (sr / 2), btype="high")
    hp = sps.filtfilt(b, a, x)

    # whiten: short-term LPC residual, so tonal content is predicted away and
    # only genuinely unpredictable energy survives
    blk = int(0.032 * sr)
    res = np.zeros_like(hp)
    for i in range(0, len(hp) - blk, blk):
        seg = hp[i: i + blk + 32]
        c = _lpc(seg, 16)
        res[i: i + blk] = (sps.lfilter(c, [1.0], seg)[:blk] if c is not None
                           else seg[:blk])

    fast = _smooth_env(res, sr, 0.5)

    # Robust local scale. The MAD of the quiet residual alone collapses to zero
    # on digitally-silent gaps, which would make every sample a "click", so it
    # is floored against the signal's own residual dynamic range.
    mad = np.median(np.abs(res[quiet])) * 1.4826
    floor = max(mad, 1e-3 * np.percentile(np.abs(res), 99.0), 1e-9)
    thresh = sens * floor

    # Peak-pick rather than group contiguous runs: a run-based grouping merges
    # a whole quiet passage into one giant "click" the moment the floor is low.
    det = np.where(quiet, fast, 0.0)
    peaks, _ = sps.find_peaks(det, height=thresh,
                              distance=max(1, int(0.002 * sr)))

    pad = int(0.0004 * sr)
    max_len = int(max_ms * 1e-3 * sr)
    fixed = 0
    for p in peaks:
        # grow outward while still above half-threshold, capped at max_ms
        lo = hi = p
        lim = max_len // 2
        while lo > 0 and p - lo < lim and det[lo - 1] > thresh * 0.5:
            lo -= 1
        while hi < len(det) - 1 and hi - p < lim and det[hi + 1] > thresh * 0.5:
            hi += 1
        s, e = max(0, lo - pad), min(len(x), hi + 1 + pad)
        if e - s > max_len:                  # clamp around the peak; padding
            s = max(0, p - max_len // 2)     # must not push a valid detection
            e = min(len(x), s + max_len)     # over the length limit
        if _repair(x, s, e):
            fixed += 1
    return x, fixed


# ------------------------------------------------- 4. neural denoise/dereverb

def neural(inp, outp, backend):
    if backend == "none":
        shutil.copy(inp, outp)
        return "skipped"

    if backend == "deepfilternet":
        from df.enhance import enhance, init_df, load_audio, save_audio
        import torch
        model, state, _ = init_df()
        audio, _ = load_audio(inp, sr=state.sr())
        with torch.no_grad():
            out = enhance(model, state, audio)
        save_audio(outp, out, state.sr())
        return "DeepFilterNet3"

    if backend == "clearvoice":
        from clearvoice import ClearVoice
        cv = ClearVoice(task="speech_enhancement",
                        model_names=["MossFormer2_SE_48K"])
        cv(input_path=inp, online_write=True, output_path=outp)
        return "MossFormer2_SE_48K"

    raise ValueError(backend)


# ----------------------------------------------------------- 5. polish chain

def polish(inp, outp, lufs=-16.0, tp=-1.0, deess=True):
    """
    De-ess, corrective EQ, gentle compression, true-peak limit, then two-pass
    EBU R128 normalisation. ffmpeg's implementations of all of these are solid
    and vectorised; there is no reason to hand-roll them.
    """
    chain = [
        "highpass=f=75:poles=2",                       # rumble the NN left behind
    ]
    if deess:
        chain.append("deesser=i=0.35:m=0.5:f=0.5:s=o")
    chain += [
        "equalizer=f=300:t=q:w=1.2:g=-2",              # box / mud
        "equalizer=f=2800:t=q:w=1.0:g=1.5",            # intelligibility
        "equalizer=f=9000:t=h:w=0.7:g=2",              # air
        "acompressor=threshold=-20dB:ratio=2.5:attack=8:release=180:makeup=2",
    ]
    filt = ",".join(chain)

    # pass 1: measure
    err = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", inp, "-af",
         f"{filt},loudnorm=I={lufs}:TP={tp - 0.5}:LRA=9:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    import json, re
    m = re.search(r"\{[^{}]*input_i[^{}]*\}", err, re.S)
    meas = json.loads(m.group(0)) if m else None

    ln = f"loudnorm=I={lufs}:TP={tp - 0.5}:LRA=9"
    if meas:
        ln += (f":measured_I={meas['input_i']}:measured_TP={meas['input_tp']}"
               f":measured_LRA={meas['input_lra']}"
               f":measured_thresh={meas['input_thresh']}"
               f":offset={meas['target_offset']}:linear=true")

    # limiter goes AFTER normalisation: put it first and loudnorm can no longer
    # raise level without clipping, and lands short of the target
    lim = f"alimiter=limit={10 ** (tp / 20.0):.4f}:attack=5:release=50:level=disabled"
    run(["ffmpeg", "-y", "-v", "error", "-i", inp, "-af",
         f"{filt},{ln},{lim}", "-ar", str(SR), "-c:a", "pcm_s24le", outp])
    return meas


# ---------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Studio-quality voice enhancement")
    ap.add_argument("input")
    ap.add_argument("-o", "--output", default="enhanced.wav")
    ap.add_argument("--backend", default="deepfilternet",
                    choices=["deepfilternet", "clearvoice", "none"])
    ap.add_argument("--lufs", type=float, default=-16.0,
                    help="-16 podcast/voiceover, -14 YouTube/Spotify")
    ap.add_argument("--true-peak", type=float, default=-1.0)
    ap.add_argument("--no-deplosive", action="store_true")
    ap.add_argument("--no-declick", action="store_true")
    ap.add_argument("--declick-after", action="store_true",
                    help="run de-click on the network output instead; use when "
                         "the source is so reverberant that the quiet-gate "
                         "never opens on the raw input")
    ap.add_argument("--no-deess", action="store_true")
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="enh_")
    try:
        x = decode(args.input)
        dur = len(x) / SR
        print(f"[1/5] decoded {dur:.1f}s @ {SR} Hz mono", file=sys.stderr)

        x -= x.mean()                                   # DC offset
        peak = np.max(np.abs(x)) or 1.0
        x *= 0.7 / peak                                 # headroom for repairs

        if not args.no_deplosive:
            x, nfr = deplosive(x)
            print(f"[2/5] de-plosive: ducked {nfr} frames", file=sys.stderr)

        if not args.no_declick and not args.declick_after:
            x, nc = declick(x)
            print(f"[3/5] de-click: repaired {nc} transients", file=sys.stderr)

        pre = os.path.join(tmp, "pre.wav")
        mid = os.path.join(tmp, "mid.wav")
        write_wav(x, pre)

        name = neural(pre, mid, args.backend)
        print(f"[4/5] denoise/dereverb: {name}", file=sys.stderr)

        if not args.no_declick and args.declick_after:
            y, nc = declick(decode(mid))
            write_wav(y, mid)
            print(f"[3/5] de-click (post): repaired {nc} transients",
                  file=sys.stderr)

        meas = polish(mid, args.output, args.lufs, args.true_peak,
                      deess=not args.no_deess)
        print(f"[5/5] polished -> {args.output}"
              + (f"  (in {float(meas['input_i']):.1f} LUFS"
                 f" -> {args.lufs} LUFS)" if meas else ""), file=sys.stderr)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()