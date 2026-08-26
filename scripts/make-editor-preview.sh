#!/usr/bin/env bash
# Build the README hero image: left half dark theme, right half light theme.
#
# Usage:
#   scripts/make-editor-preview.sh <dark-screenshot.png> <light-screenshot.png>
#
# Writes into assets/:
#   screenshot-dark.png    copy of the dark-theme screenshot
#   screenshot-light.png   copy of the light-theme screenshot
#   editor-preview.png     the split image referenced by README.md
#
# Both screenshots must be the same size, taken of the same window state,
# so the seam lands cleanly. Needs ffmpeg on PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO_ROOT/assets"

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <dark-screenshot.png> <light-screenshot.png>" >&2
  exit 1
fi
DARK="$1"
LIGHT="$2"

for f in "$DARK" "$LIGHT"; do
  if [[ ! -f "$f" ]]; then
    echo "error: not found: $f" >&2
    echo "hint: macOS screenshot names contain a narrow no-break space before AM/PM;" >&2
    echo "      tab-complete the path or use a glob like ~/Desktop/Screenshot*5.28.18*.png" >&2
    exit 1
  fi
done

command -v ffmpeg >/dev/null 2>&1 || { echo "error: ffmpeg not on PATH" >&2; exit 1; }

dims() { ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$1"; }
d1="$(dims "$DARK")"; d2="$(dims "$LIGHT")"
if [[ "$d1" != "$d2" ]]; then
  echo "error: size mismatch — dark is ${d1}, light is ${d2}; retake so both match" >&2
  exit 1
fi

cp "$DARK" "$OUT/screenshot-dark.png"
cp "$LIGHT" "$OUT/screenshot-light.png"

ffmpeg -y -v error \
  -i "$OUT/screenshot-dark.png" -i "$OUT/screenshot-light.png" \
  -filter_complex "[0:v]crop=iw/2:ih:0:0[left];[1:v]crop=iw/2:ih:iw/2:0[right];[left][right]hstack" \
  -frames:v 1 "$OUT/editor-preview.png"

echo "wrote $OUT/screenshot-dark.png"
echo "wrote $OUT/screenshot-light.png"
echo "wrote $OUT/editor-preview.png (${d1%,*}x${d1#*,})"
