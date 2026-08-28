from __future__ import annotations

import argparse
import time
import wave
from pathlib import Path

from pyrnnoise import RNNoise


def wav_facts(path: Path) -> tuple[float, int]:
    """Duration in seconds and the file's actual sample rate."""
    with wave.open(str(path), "rb") as wav:
        frames = wav.getnframes()
        rate = wav.getframerate()
        return frames / float(rate), rate


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark RNNoise speech denoising."
    )
    parser.add_argument("input", type=Path)
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        default=Path("denoised.wav"),
    )

    args = parser.parse_args()

    if not args.input.exists():
        raise FileNotFoundError(args.input)

    duration, sample_rate = wav_facts(args.input)

    print()
    print("RNNoise benchmark")
    print("-----------------")
    print(f"Input:           {args.input}")
    print(f"Output:          {args.output}")
    print(f"Audio duration:  {duration:.2f}s")
    print(f"Sample rate:     {sample_rate} Hz")

    # The file's own rate, not a hardcoded 48000: RNNoise resamples
    # internally to its 48k frames either way, but lying about the input
    # rate time-stretches the output.
    denoiser = RNNoise(sample_rate=sample_rate)

    start = time.perf_counter()

    speech_prob_sum = 0.0
    speech_prob_count = 0

    for probabilities in denoiser.denoise_wav(
        str(args.input),
        str(args.output),
    ):
        # stereo may return more than one probability
        try:
            values = list(probabilities)
        except TypeError:
            values = [float(probabilities)]

        for value in values:
            speech_prob_sum += float(value)
            speech_prob_count += 1

    elapsed = time.perf_counter() - start

    realtime_factor = elapsed / duration if duration else 0.0
    speed = duration / elapsed if elapsed else 0.0

    print(f"Processing time: {elapsed:.3f}s")
    print(f"Realtime factor: {realtime_factor:.4f}x")
    print(f"Speed:           {speed:.1f}x realtime")

    if speech_prob_count:
        print(
            f"Avg speech prob: "
            f"{speech_prob_sum / speech_prob_count:.3f}"
        )

    print()
    print("Done.")
    print("Listen to A/B:")
    print(f"  original: {args.input}")
    print(f"  denoised: {args.output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())