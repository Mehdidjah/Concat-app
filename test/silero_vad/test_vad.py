# test/silero_vad/test_vad.py

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from silero_vad import (
    load_silero_vad,
    read_audio,
    get_speech_timestamps,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark Silero VAD and print detected speech regions."
    )
    parser.add_argument("input", type=Path, help="Input audio file")
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="Speech probability threshold (default: 0.5)",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="Optional path to save detected regions as JSON",
    )

    args = parser.parse_args()

    if not args.input.exists():
        raise FileNotFoundError(args.input)

    model_start = time.perf_counter()
    model = load_silero_vad(onnx=True)
    model_load_time = time.perf_counter() - model_start

    audio_start = time.perf_counter()
    audio = read_audio(str(args.input), sampling_rate=16000)
    audio_load_time = time.perf_counter() - audio_start

    duration_seconds = len(audio) / 16000.0

    inference_start = time.perf_counter()

    segments = get_speech_timestamps(
        audio,
        model,
        sampling_rate=16000,
        threshold=args.threshold,
        return_seconds=True,
    )

    inference_time = time.perf_counter() - inference_start

    speech_seconds = sum(
        float(segment["end"]) - float(segment["start"])
        for segment in segments
    )

    realtime_factor = (
        inference_time / duration_seconds
        if duration_seconds > 0
        else 0.0
    )

    print()
    print("Silero VAD")
    print("----------")
    print(f"File:           {args.input}")
    print(f"Audio duration: {duration_seconds:.2f}s")
    print(f"Model load:     {model_load_time:.3f}s")
    print(f"Audio load:     {audio_load_time:.3f}s")
    print(f"Inference:      {inference_time:.3f}s")
    print(f"Realtime factor:{realtime_factor:.4f}x")
    print(f"Speed:          {1 / realtime_factor:.1f}x realtime"
          if realtime_factor > 0 else "Speed:          n/a")
    print(f"Speech:         {speech_seconds:.2f}s")
    print(f"Segments:       {len(segments)}")
    print()

    for i, segment in enumerate(segments, start=1):
        start = float(segment["start"])
        end = float(segment["end"])

        print(
            f"{i:03d} | "
            f"{start:8.3f}s -> {end:8.3f}s | "
            f"{end - start:6.3f}s"
        )

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)

        result = {
            "input": str(args.input),
            "duration_seconds": duration_seconds,
            "inference_seconds": inference_time,
            "realtime_factor": realtime_factor,
            "speech_seconds": speech_seconds,
            "segments": segments,
        }

        args.json.write_text(
            json.dumps(result, indent=2),
            encoding="utf-8",
        )

        print(f"\nSaved: {args.json}")

    return 0

if __name__ == "__main__":
    raise SystemExit(main())