from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from scenedetect import ContentDetector, SceneManager, open_video


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Detect scene cuts and benchmark processing speed."
    )
    parser.add_argument("input", type=Path)

    parser.add_argument(
        "--threshold",
        type=float,
        default=27.0,
        help="Higher = fewer cuts. Default: 27.",
    )

    parser.add_argument(
        "--min-scene-frames",
        type=int,
        default=15,
        help="Minimum scene length in frames.",
    )

    parser.add_argument(
        "--json",
        type=Path,
        default=None,
    )

    args = parser.parse_args()

    if not args.input.exists():
        raise FileNotFoundError(args.input)

    video = open_video(str(args.input))

    duration_seconds = video.duration.get_seconds()
    fps = video.frame_rate

    manager = SceneManager()

    manager.add_detector(
        ContentDetector(
            threshold=args.threshold,
            min_scene_len=args.min_scene_frames,
        )
    )

    start = time.perf_counter()

    frames_processed = manager.detect_scenes(
        video=video,
        show_progress=True,
    )

    elapsed = time.perf_counter() - start

    scenes = manager.get_scene_list()

    speed = duration_seconds / elapsed if elapsed else 0
    processing_fps = frames_processed / elapsed if elapsed else 0

    print()
    print("Scene Detection")
    print("---------------")
    print(f"Input:          {args.input}")
    print(f"Duration:       {duration_seconds:.2f}s")
    print(f"Source FPS:     {fps:.2f}")
    print(f"Frames:         {frames_processed}")
    print(f"Scenes:         {len(scenes)}")
    print(f"Processing:     {elapsed:.3f}s")
    print(f"Speed:          {speed:.1f}x realtime")
    print(f"Analysis FPS:   {processing_fps:.1f}")
    print()

    results = []

    for index, (start_tc, end_tc) in enumerate(scenes, start=1):
        start_sec = start_tc.get_seconds()
        end_sec = end_tc.get_seconds()

        results.append(
            {
                "scene": index,
                "start": start_sec,
                "end": end_sec,
                "duration": end_sec - start_sec,
            }
        )

        print(
            f"{index:03d} | "
            f"{start_sec:8.3f}s -> "
            f"{end_sec:8.3f}s | "
            f"{end_sec - start_sec:7.3f}s"
        )

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)

        args.json.write_text(
            json.dumps(
                {
                    "input": str(args.input),
                    "threshold": args.threshold,
                    "duration_seconds": duration_seconds,
                    "processing_seconds": elapsed,
                    "speed_realtime": speed,
                    "scenes": results,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        print(f"\nSaved: {args.json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())