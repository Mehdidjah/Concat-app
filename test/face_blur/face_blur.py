from __future__ import annotations

import argparse
import time
from pathlib import Path

import cv2


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(value, high))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Detect faces with YuNet and blur them."
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--model",
        type=Path,
        default=Path("face_detection_yunet_2026may.onnx"),
    )
    parser.add_argument(
        "--confidence",
        type=float,
        default=0.85,
    )
    parser.add_argument(
        "--padding",
        type=float,
        default=0.18,
        help="Extra padding around detected faces.",
    )

    args = parser.parse_args()

    if not args.input.exists():
        raise FileNotFoundError(args.input)

    if not args.model.exists():
        raise FileNotFoundError(args.model)

    capture = cv2.VideoCapture(str(args.input))

    if not capture.isOpened():
        raise RuntimeError(f"Could not open {args.input}")

    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    # Some containers report no rate; 30 keeps the writer producing a
    # playable file rather than one with a zero timebase.
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))

    duration = frame_count / fps

    detector = cv2.FaceDetectorYN.create(
        str(args.model),
        "",
        (width, height),
        args.confidence,
        0.3,
        5000,
    )

    writer = cv2.VideoWriter(
        str(args.output),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )

    if not writer.isOpened():
        raise RuntimeError("Could not create output video")

    processed = 0
    detected_faces = 0

    start_time = time.perf_counter()

    while True:
        ok, frame = capture.read()

        if not ok:
            break

        detector.setInputSize((frame.shape[1], frame.shape[0]))

        _, faces = detector.detect(frame)

        if faces is not None:
            for face in faces:
                x, y, w, h = face[:4]

                x = int(x)
                y = int(y)
                w = int(w)
                h = int(h)

                pad_x = int(w * args.padding)
                pad_y = int(h * args.padding)

                x1 = clamp(x - pad_x, 0, width)
                y1 = clamp(y - pad_y, 0, height)
                x2 = clamp(x + w + pad_x, 0, width)
                y2 = clamp(y + h + pad_y, 0, height)

                region = frame[y1:y2, x1:x2]

                if region.size == 0:
                    continue

                # Kernel roughly proportional to face size.
                kernel = max(15, min(w, h) // 3)
                kernel |= 1  # Gaussian kernel must be odd.

                blurred = cv2.GaussianBlur(
                    region,
                    (kernel, kernel),
                    0,
                )

                frame[y1:y2, x1:x2] = blurred
                detected_faces += 1

        writer.write(frame)
        processed += 1

    elapsed = time.perf_counter() - start_time

    capture.release()
    writer.release()

    processing_fps = processed / elapsed if elapsed else 0.0
    realtime_speed = duration / elapsed if elapsed else 0.0

    print()
    print("YuNet Face Blur")
    print("---------------")
    print(f"Resolution:      {width}x{height}")
    print(f"Frames:          {processed}")
    print(f"Duration:        {duration:.2f}s")
    print(f"Faces detected:  {detected_faces}")
    print(f"Processing time: {elapsed:.2f}s")
    print(f"Processing FPS:  {processing_fps:.1f}")
    print(f"Speed:           {realtime_speed:.2f}x realtime")
    print(f"Output:          {args.output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())