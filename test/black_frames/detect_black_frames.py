from __future__ import annotations

import argparse
import time
from pathlib import Path

import cv2
import numpy as np


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Detect black or near-black regions in a video."
    )
    parser.add_argument("input", type=Path)

    parser.add_argument(
        "--threshold",
        type=int,
        default=16,
        help="Pixel luminance considered black. Default: 16/255.",
    )

    parser.add_argument(
        "--black-percent",
        type=float,
        default=0.98,
        help="Fraction of pixels that must be black. Default: 0.98.",
    )

    parser.add_argument(
        "--min-duration",
        type=float,
        default=0.10,
        help="Minimum black segment duration in seconds.",
    )

    args = parser.parse_args()

    if not args.input.exists():
        raise FileNotFoundError(args.input)

    cap = cv2.VideoCapture(str(args.input))

    if not cap.isOpened():
        raise RuntimeError(f"Could not open {args.input}")

    # Some containers report no rate; 30 keeps the timestamps usable rather
    # than dividing by zero on the first frame.
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps

    black_segments: list[tuple[float, float]] = []

    segment_start: float | None = None

    frame_index = 0
    start_time = time.perf_counter()

    while True:
        ok, frame = cap.read()

        if not ok:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        black_ratio = np.count_nonzero(gray <= args.threshold) / gray.size
        is_black = black_ratio >= args.black_percent

        timestamp = frame_index / fps

        if is_black:
            if segment_start is None:
                segment_start = timestamp

        elif segment_start is not None:
            segment_end = timestamp

            if segment_end - segment_start >= args.min_duration:
                black_segments.append((segment_start, segment_end))

            segment_start = None

        frame_index += 1

    if segment_start is not None:
        segment_end = frame_index / fps

        if segment_end - segment_start >= args.min_duration:
            black_segments.append((segment_start, segment_end))

    elapsed = time.perf_counter() - start_time

    cap.release()

    speed = duration / elapsed if elapsed else 0.0
    processing_fps = frame_index / elapsed if elapsed else 0.0

    print()
    print("Black Frame Detection")
    print("---------------------")
    print(f"Input:           {args.input}")
    print(f"Duration:        {duration:.2f}s")
    print(f"Frames:          {frame_index}")
    print(f"Processing:      {elapsed:.2f}s")
    print(f"Processing FPS:  {processing_fps:.1f}")
    print(f"Speed:           {speed:.1f}x realtime")
    print(f"Black segments:  {len(black_segments)}")
    print()

    for i, (start, end) in enumerate(black_segments, 1):
        print(
            f"{i:03d} | "
            f"{start:8.3f}s -> {end:8.3f}s | "
            f"{end - start:6.3f}s"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())