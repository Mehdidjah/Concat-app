/**
 * Display formatting for time.
 *
 * The UI never does time *arithmetic* - that belongs in the engine, in exact
 * rational seconds. These helpers only turn a number into something to look at.
 */

/** Formats seconds as `HH:MM:SS:FF` at the given frame rate. */
export function timecode(seconds: number, frameRate: number): string {
  const safe = Math.max(0, seconds);
  const totalFrames = Math.floor(safe * frameRate);
  // Both fields derive from the frame count - non-drop-frame timecode. The
  // seconds used to come from the wall clock instead, so at 29.97 the frame
  // field disagreed with its own seconds near boundaries (00:01:40:27 where
  // :00 belonged). NDF runs slightly behind the wall clock at NTSC rates;
  // that is the standard trade, not a bug.
  const fps = Math.max(1, Math.round(frameRate));
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);

  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    pad(Math.floor(totalSeconds / 3600)),
    pad(Math.floor(totalSeconds / 60) % 60),
    pad(totalSeconds % 60),
    pad(frames),
  ].join(":");
}

/**
 * Formats a timestamp as how long ago it was.
 *
 * Coarse on purpose: "3 days ago" is what you want from a recents list, and a
 * precise date is noise until it is old enough to actually be a date.
 */
export function relativeTime(milliseconds: number): string {
  const seconds = Math.max(0, (Date.now() - milliseconds) / 1000);

  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (seconds < 7 * 86_400) {
    const days = Math.round(seconds / 86_400);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  return new Date(milliseconds).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Formats seconds as `M:SS`, for places where a full timecode is noise. */
export function shortDuration(seconds: number | null): string {
  if (seconds === null) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${(whole % 60).toString().padStart(2, "0")}`;
}
