/**
 * The audio filter catalogue.
 *
 * Every filter is a function from parameters to an FFmpeg filter fragment.
 * That is the whole design: there is one description of what a filter does,
 * it produces a string, and both the exporter and the preview run that same
 * string through FFmpeg. They cannot drift, because there is nothing to drift
 * between - no second implementation in Web Audio approximating the first.
 *
 * The cost is that a filtered clip has to be rendered before it can be heard.
 * See `lib/audio.ts`; the alternative was a preview that lies.
 */

export type FilterCategory = "voice" | "tone" | "space";

export interface FilterParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Turns the raw number into what the reader sees. */
  format: (value: number) => string;
}

export interface FilterDefinition {
  id: string;
  label: string;
  category: FilterCategory;
  /** One line on what it does, shown under the name. */
  blurb: string;
  params: FilterParam[];
  /** Builds the FFmpeg fragment for these parameter values. */
  chain: (params: Record<string, number>) => string;
}

/** A filter applied to a clip, with whatever parameters were set. */
export interface ClipFilter {
  id: string;
  params: Record<string, number>;
}

export const CATEGORIES: { id: FilterCategory; label: string }[] = [
  { id: "voice", label: "Voice" },
  { id: "tone", label: "Tone" },
  { id: "space", label: "Space" },
];

const percent = (value: number) => `${Math.round(value)}%`;
const semitones = (value: number) =>
  `${value > 0 ? "+" : ""}${value.toFixed(1)} st`;
const decibels = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
const seconds = (value: number) => `${value.toFixed(2)}s`;

/**
 * Pitch shift that moves the formants with the pitch.
 *
 * Raising the sample rate and then resampling back shifts everything - which
 * is why it sounds like a different voice rather than the same voice
 * transposed. `atempo` then puts the duration back, because `asetrate` alone
 * would also make the clip shorter.
 *
 * This is the technique the whole Voice category is built on.
 */
function pitchShift(semitoneShift: number): string[] {
  const ratio = 2 ** (semitoneShift / 12);
  return [
    "aresample=48000",
    `asetrate=${(48000 * ratio).toFixed(6)}`,
    "aresample=48000",
    `atempo=${(1 / ratio).toFixed(8)}`,
  ];
}

export const FILTERS: FilterDefinition[] = [
  {
    id: "sweet",
    label: "Sweet",
    category: "voice",
    blurb: "Brighter, softer and a little higher. Ported from the reference chain.",
    params: [
      {
        key: "amount",
        label: "Amount",
        min: 0,
        max: 100,
        step: 1,
        default: 65,
        format: percent,
      },
      {
        key: "pitch",
        label: "Pitch",
        min: 0,
        max: 8,
        step: 0.1,
        // 0 means "follow amount", which is what the original did when no
        // explicit pitch was passed.
        default: 0,
        format: (value) => (value === 0 ? "auto" : semitones(value)),
      },
    ],
    chain: ({ amount = 65, pitch = 0 }) => {
      const strength = Math.max(0, Math.min(100, amount)) / 100;

      /*
       * The filter chain below is the reference implementation, unchanged.
       * These *coefficients* are not.
       *
       * The original mapped the whole 0-100 slider onto 1.2-2.7 semitones and
       * about 2 dB of EQ, so dragging it end to end barely changed anything -
       * a faithful port of numbers that made a poor control. The shape is the
       * same and the low end still matches; the top now goes somewhere.
       *
       * Original, if you want the subtler feel back:
       *   shift    = 1.2 + 1.5 * strength
       *   presence = 0.8 + 1.5 * strength
       *   air      = 1.0 + 2.0 * strength
       *   deess    = 0.18 + 0.22 * strength
       *   echo     = 0.012 + 0.018 * strength
       */
      const shift = pitch > 0 ? pitch : 1.2 + 3.8 * strength;
      const presence = 0.8 + 5.2 * strength;
      const air = 1.0 + 7.0 * strength;
      const deess = 0.18 + 0.32 * strength;
      const echo = 0.012 + 0.048 * strength;

      return [
        ...pitchShift(shift),
        "highpass=f=85",
        "equalizer=f=300:t=q:w=1.1:g=-1.4",
        `equalizer=f=4200:t=q:w=0.8:g=${presence.toFixed(3)}`,
        `equalizer=f=10500:t=q:w=0.7:g=${air.toFixed(3)}`,
        "compand=attacks=0.010:decays=0.180:points=-80/-80|-30/-24|-18/-13|-8/-5|0/-1.5:soft-knee=5:gain=1",
        `deesser=i=${deess.toFixed(3)}:m=0.45:f=0.55`,
        `aecho=0.8:0.82:38:${echo.toFixed(4)}`,
        "alimiter=limit=0.94:attack=5:release=60",
      ].join(",");
    },
  },
  {
    id: "deep",
    label: "Deep",
    category: "voice",
    blurb: "Lower and heavier, with the low end lifted to match.",
    params: [
      { key: "pitch", label: "Pitch", min: -8, max: -1, step: 0.1, default: -3, format: semitones },
      { key: "body", label: "Body", min: 0, max: 8, step: 0.5, default: 3, format: decibels },
    ],
    chain: ({ pitch = -3, body = 3 }) =>
      [
        ...pitchShift(pitch),
        "highpass=f=55",
        `equalizer=f=140:t=q:w=1.0:g=${body.toFixed(2)}`,
        "equalizer=f=2600:t=q:w=0.9:g=-1.2",
        "alimiter=limit=0.94:attack=5:release=60",
      ].join(","),
  },
  {
    id: "chipmunk",
    label: "Chipmunk",
    category: "voice",
    blurb: "Sharply higher. Formants move too, so it is a different voice.",
    params: [
      { key: "pitch", label: "Pitch", min: 3, max: 12, step: 0.5, default: 7, format: semitones },
    ],
    chain: ({ pitch = 7 }) =>
      [...pitchShift(pitch), "highpass=f=120", "alimiter=limit=0.94"].join(","),
  },
  {
    id: "robot",
    label: "Robot",
    category: "voice",
    blurb: "Flattened and metallic, from a very short modulated delay.",
    params: [
      { key: "depth", label: "Depth", min: 1, max: 10, step: 0.5, default: 5, format: percent },
    ],
    chain: ({ depth = 5 }) =>
      [
        // aphaser caps speed at 2, so depth maps into 0.4-2.0 rather than
        // being halved - which put it out of range and made the filter refuse.
        `aphaser=type=t:speed=${(0.4 + (depth / 10) * 1.6).toFixed(2)}:decay=0.6`,
        "flanger=delay=2:depth=4:speed=0.8",
        "equalizer=f=1800:t=q:w=1.2:g=3",
        "alimiter=limit=0.94",
      ].join(","),
  },

  {
    id: "bass",
    label: "Bass boost",
    category: "tone",
    blurb: "Lifts the low end without touching anything above it.",
    params: [
      { key: "gain", label: "Gain", min: 0, max: 12, step: 0.5, default: 5, format: decibels },
    ],
    chain: ({ gain = 5 }) => `bass=g=${gain.toFixed(2)}:f=110:w=0.6,alimiter=limit=0.95`,
  },
  {
    id: "treble",
    label: "Treble boost",
    category: "tone",
    blurb: "Adds air at the top. Useful on dull recordings.",
    params: [
      { key: "gain", label: "Gain", min: 0, max: 12, step: 0.5, default: 4, format: decibels },
    ],
    chain: ({ gain = 4 }) => `treble=g=${gain.toFixed(2)}:f=9000:w=0.7,alimiter=limit=0.95`,
  },
  {
    id: "telephone",
    label: "Telephone",
    category: "tone",
    blurb: "Band-limited to a phone line, everything else discarded.",
    params: [
      { key: "drive", label: "Drive", min: 0, max: 10, step: 0.5, default: 3, format: percent },
    ],
    chain: ({ drive = 3 }) =>
      [
        "highpass=f=400",
        "lowpass=f=3400",
        `equalizer=f=1600:t=q:w=1.4:g=${(3 + drive / 2).toFixed(2)}`,
        "alimiter=limit=0.92",
      ].join(","),
  },

  {
    id: "echo",
    label: "Echo",
    category: "space",
    blurb: "A single distinct repeat.",
    params: [
      { key: "delay", label: "Delay", min: 0.05, max: 1, step: 0.01, default: 0.25, format: seconds },
      { key: "decay", label: "Decay", min: 0.1, max: 0.9, step: 0.05, default: 0.4, format: percent },
    ],
    chain: ({ delay = 0.25, decay = 0.4 }) =>
      `aecho=0.8:0.85:${Math.round(delay * 1000)}:${decay.toFixed(2)}`,
  },
  {
    id: "room",
    label: "Room",
    category: "space",
    blurb: "Several short reflections, so it sits in a space rather than repeating.",
    params: [
      { key: "size", label: "Size", min: 0, max: 100, step: 1, default: 40, format: percent },
    ],
    chain: ({ size = 40 }) => {
      const scale = 0.4 + (size / 100) * 1.6;
      const taps = [23, 41, 67, 97].map((ms) => Math.round(ms * scale));
      const gains = [0.32, 0.24, 0.17, 0.11].map((g) => g.toFixed(3));
      return `aecho=0.8:0.88:${taps.join("|")}:${gains.join("|")}`;
    },
  },
];

export function findFilter(id: string): FilterDefinition | null {
  return FILTERS.find((filter) => filter.id === id) ?? null;
}

/** Fills in any parameter the clip did not set. */
export function resolveParams(
  definition: FilterDefinition,
  params: Record<string, number>,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const param of definition.params) {
    resolved[param.key] = params[param.key] ?? param.default;
  }
  return resolved;
}

/**
 * The complete FFmpeg filter string for a clip, or null if it has none.
 *
 * Filters apply in the order they were added, which is why `filters` is an
 * array: EQ before a limiter is a different sound from the reverse.
 */
export function buildChain(filters: readonly ClipFilter[]): string | null {
  const fragments = filters.flatMap((applied) => {
    const definition = findFilter(applied.id);
    if (!definition) return [];
    return [definition.chain(resolveParams(definition, applied.params))];
  });

  return fragments.length > 0 ? fragments.join(",") : null;
}

/**
 * A stable key for "this exact filtered audio".
 *
 * Used to cache rendered results, so dragging a slider back to a value you
 * already heard plays instantly instead of re-rendering.
 */
export function chainKey(
  mediaId: string,
  sourceStart: number,
  duration: number,
  filters: readonly ClipFilter[],
): string {
  return `${mediaId}|${sourceStart.toFixed(3)}|${duration.toFixed(3)}|${buildChain(filters) ?? ""}`;
}
