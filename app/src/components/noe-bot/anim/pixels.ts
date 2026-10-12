/**
 * The character's pixels, as the design's film draws them.
 *
 * 14 columns by 12 rows. In text it is six rows of half-block glyphs (`▀` top pixel, `▄` bottom,
 * `█` both, space neither); the body (rows 0–1 and 10–11) never changes and every expression is a
 * different pattern of holes in rows 2–9. Ears, hands and legs are drawn on top from their own
 * tables. Data verbatim from `noe-bot-film.jsx`; nothing here is drawn by hand.
 */

export const COLS = 14;
export const ROWS = 12;
export const CELLS = COLS * ROWS;

/** 168 cells, row-major, 1 where the body has ink. */
export type Px = readonly number[];

const TOP = "  ▄██▄▄▄▄██▄";
const R1 = " ████████████";
const BOT = "  ▀██▀▀▀▀██▀";
const F = (
  r1: string | 0,
  a: string,
  b: string,
  r4: string | 0 = 0,
): readonly string[] => [TOP, r1 || R1, a, b, r4 || R1, BOT];

/** Half-block rows to pixels: each text row is two pixel rows. */
export const toPixels = (rows: readonly string[]): number[] => {
  const px: number[] = Array.from({ length: CELLS }, () => 0);
  rows.forEach((row, r) => {
    for (let c = 0; c < COLS; c++) {
      const ch = row[c] ?? " ";
      px[r * 2 * COLS + c] = ch === "█" || ch === "▀" ? 1 : 0;
      px[(r * 2 + 1) * COLS + c] = ch === "█" || ch === "▄" ? 1 : 0;
    }
  });
  return px;
};

/**
 * The 18 faces of the brand sheet (00 original … 17 injured) and the film's helper faces: the
 * blink frame, the reading and glancing eyes the actions use, the side profile, and `blank` (every
 * eye cell filled, for faces that draw their own eyes as props).
 */
export const FACE_ROWS = {
  original: F(0, "▄████ ██ ████▄", "▀████ ██ ████▀"),
  blink: F(0, "▄████████████▄", "▀████▀██▀████▀"),
  neutral: F(0, "▄███▀ ██ ▀███▄", "▀███▄ ██ ▄███▀"),
  attentive: F(0, "▄████▀██▀████▄", "▀████▄██▄████▀"),
  surprised: F(0, "▄██▀▀████▀▀██▄", "▀██▄▄████▄▄██▀"),
  excited: F(
    " ████▀██▀████",
    "▄███  ██  ███▄",
    "▀███  ██  ███▀",
    " ████▄██▄████",
  ),
  happy: F(0, "▄██▀▄▀██▀▄▀██▄", "▀██▄█▄██▄█▄██▀"),
  laughing: F(0, "▄███▀████▀███▄", "▀██▄█▄██▄█▄██▀"),
  angry: F(0, "▄██▄ ▀██▀ ▄██▄", "▀████▄██▄████▀"),
  sad: F(0, "▄███ ▄██▄ ███▄", "▀██▄██████▄██▀"),
  scared: F(0, "▄████████████▄", "▀███▀████▀███▀"),
  suspicious: F(0, "▄██▀▀████▀▀██▄", "▀████▄██▄████▀"),
  confused: F(
    " ███▀████████",
    "▄███▄▀███████▄",
    "▀████▄██▀▀███▀",
    " █████████▄██",
  ),
  curious: F(" ████████▀▀██", "▄███▀▄███▄▄██▄", "▀████████████▀"),
  proud: F(0, "▄██▄▀▄██▄▀▄██▄", "▀████████████▀"),
  shy: F(0, "▄████████████▄", "▀██▀▄████▄▀██▀"),
  unimpressed: F(0, "▄██▀▀▀██▀▀▀██▄", "▀████████████▀"),
  sleepy: F(0, "▄████████████▄", "▀██▄▀▄██▄▀▄██▀"),
  injured: F(0, "▄██▀ ▀██▀ ▀██▄", "▀███▄████▄███▀"),
  reading: F(0, "▄████████████▄", "▀████ ██ ████▀"),
  lookL: F(0, "▄███ ██ █████▄", "▀███ ██ █████▀"),
  lookR: F(0, "▄█████ ██ ███▄", "▀█████ ██ ███▀"),
  readL: F(0, "▄████████████▄", "▀███ ██ █████▀"),
  readR: F(0, "▄████████████▄", "▀█████ ██ ███▀"),
  side: F(0, "▄████████ █ █▄", "▀████████ █ █▀"),
} as const;

export type RowFace = keyof typeof FACE_ROWS;

/** The brand sheet's 18 faces, numbered 00–17 in this order; dizzy and cool are film additions. */
export const ORIGINAL_FACES = [
  "original",
  "neutral",
  "attentive",
  "surprised",
  "excited",
  "happy",
  "laughing",
  "angry",
  "sad",
  "scared",
  "suspicious",
  "confused",
  "curious",
  "proud",
  "shy",
  "unimpressed",
  "sleepy",
  "injured",
  "dizzy",
  "cool",
] as const;

export type OriginalFace = (typeof ORIGINAL_FACES)[number];

const rowPx = Object.fromEntries(
  Object.entries(FACE_ROWS).map(([key, rows]) => [key, toPixels(rows)]),
) as Record<RowFace, number[]>;

/** The body with every eye cell filled: rows 2–9, cols 1–12 all ink. */
export const FILLED: Px = (() => {
  const p = rowPx.original.slice();
  for (let r = 2; r <= 9; r++)
    for (let c = 1; c <= 12; c++) p[r * COLS + c] = 1;
  return p;
})();

/** An 8 × 12 grid of the eye region (pixel rows 2–9, cols 1–12), `o` = hole, to pixels. */
export const gridPx = (rows: readonly string[]): number[] => {
  const p = FILLED.slice();
  rows.forEach((row, r) => {
    row.split("").forEach((ch, c) => {
      if (ch === "o") p[(r + 2) * COLS + c + 1] = 0;
    });
  });
  return p;
};

/** Pixels for the faces drawn from half-block rows, plus the film's aliases. */
export const ROW_FACE_PX: Record<RowFace | "dizzy" | "cool" | "blank", Px> = {
  ...rowPx,
  dizzy: rowPx.confused,
  cool: rowPx.neutral,
  blank: FILLED,
};

export const isHand = (r: number, c: number): boolean =>
  (r === 5 || r === 6) && (c === 0 || c === 13);
export const isLeg = (r: number, c: number): boolean =>
  r === 11 && (c === 3 || c === 4 || c === 9 || c === 10);
export const isEar = (r: number, c: number): boolean =>
  r === 0 && (c === 3 || c === 4 || c === 9 || c === 10);

/** Ear shapes: height level and the left ear's cells; the right ear mirrors col → 13 − col. */
export const EAR = {
  droop: {
    h: 0,
    cells: [
      [2, 0],
      [1, 1],
    ],
  },
  flat: { h: 1, cells: [[3, 0]] },
  splay: {
    h: 1,
    cells: [
      [2, 0],
      [3, 0],
    ],
  },
  inward: {
    h: 2,
    cells: [
      [4, 0],
      [5, 0],
    ],
  },
  normal: {
    h: 2,
    cells: [
      [3, 0],
      [4, 0],
    ],
  },
  lean: {
    h: 3,
    cells: [
      [3, -1],
      [3, 0],
      [4, 0],
    ],
  },
  pointy: {
    h: 3,
    cells: [
      [4, -1],
      [3, 0],
      [4, 0],
    ],
  },
  tall: {
    h: 4,
    cells: [
      [4, -1],
      [3, 0],
      [4, 0],
      [5, 0],
    ],
  },
} as const satisfies Record<
  string,
  { h: number; cells: readonly (readonly [number, number])[] }
>;

export type EarShape = keyof typeof EAR;

/** Height changes of two or more levels step through this, one frame per step. */
export const EAR_LADDER: readonly EarShape[] = [
  "droop",
  "splay",
  "normal",
  "pointy",
  "tall",
];

/** `[left, right]` ear pose per face; faces not listed take the neutral family's. */
export const EAR_POSE: Record<string, readonly [EarShape, EarShape]> = {
  earNormal: ["normal", "normal"],
  earTall: ["tall", "tall"],
  attentive: ["tall", "tall"],
  surprised: ["tall", "tall"],
  proud: ["tall", "tall"],
  happy: ["pointy", "pointy"],
  angry: ["splay", "splay"],
  unimpressed: ["splay", "splay"],
  sad: ["droop", "droop"],
  sleepy: ["droop", "droop"],
  scared: ["inward", "inward"],
  shy: ["inward", "inward"],
  suspicious: ["flat", "pointy"],
  confused: ["pointy", "droop"],
  curious: ["normal", "tall"],
  injured: ["splay", "droop"],
  dizzy: ["flat", "flat"],
};

export type HandPose = {
  l: readonly [number, number];
  r: readonly [number, number];
  /** Wave amplitude and frequency. */
  w: number;
  f: number;
  /** The hands alternate; only the right hand moves; a nervous shake amplitude. */
  alt?: 1;
  rOnly?: 1;
  sx?: number;
};

/** Hand poses in grid units: `[dx, dy]` per side (dx < 0 = outward for the left hand). */
export const POSES: Record<string, HandPose> = {
  original: { l: [0, 0], r: [0, 0], w: 0.25, f: 0.5, alt: 1 },
  blink: { l: [0, 0], r: [0, 0], w: 0.25, f: 0.5, alt: 1 },
  neutral: { l: [0, 0], r: [0, 0], w: 0.25, f: 0.5, alt: 1 },
  attentive: { l: [-0.5, -1], r: [0.5, -1], w: 0.2, f: 0.8 },
  surprised: { l: [-1, -2.5], r: [1, -2.5], w: 0.15, f: 3 },
  excited: { l: [-0.5, -3], r: [0.5, -3], w: 1.2, f: 3.2, alt: 1 },
  happy: { l: [-0.5, -1.5], r: [0.5, -1.5], w: 0.7, f: 1.6, alt: 1 },
  laughing: { l: [0, 0.5], r: [0, 0.5], w: 0.6, f: 4 },
  angry: { l: [-1, -0.5], r: [1, -0.5], w: 0, f: 0, sx: 0.35 },
  sad: { l: [0, 2], r: [0, 2], w: 0.1, f: 0.4 },
  scared: { l: [0.6, -1.5], r: [-0.6, -1.5], w: 0, f: 0, sx: 0.2 },
  suspicious: { l: [0, 0], r: [0.5, -0.5], w: 0.2, f: 0.6, alt: 1 },
  confused: { l: [0, 1], r: [-0.4, -4.5], w: 0.5, f: 2.2, alt: 1, rOnly: 1 },
  curious: { l: [0, 0], r: [0.4, -2.5], w: 0.3, f: 1, alt: 1, rOnly: 1 },
  proud: { l: [0.5, 1.5], r: [-0.5, 1.5], w: 0.1, f: 0.5 },
  shy: { l: [1, 1], r: [-1, 1], w: 0.15, f: 1.2, alt: 1 },
  unimpressed: { l: [0, 1], r: [0, 1], w: 0, f: 0 },
  sleepy: { l: [0, 2], r: [0, 2], w: 0.2, f: 0.3 },
  injured: { l: [0, 0], r: [0.5, 1.5], w: 0.25, f: 1.4, sx: 0.08 },
};

export type LegPose = {
  lift: number;
  f: number;
  alt?: 1;
  rOnly?: 1;
  lOnly?: 1;
  kick?: number;
  sx?: number;
  l?: readonly [number, number];
  r?: readonly [number, number];
};

/** Legs: pixel row 11, cols 3–4 (left) and 9–10 (right). */
export const LEGS: Record<string, LegPose> = {
  original: { lift: 0, f: 0 },
  blink: { lift: 0, f: 0 },
  neutral: { lift: 0.25, f: 0.25, alt: 1 },
  attentive: { lift: 0, f: 0, l: [0, 0.3], r: [0, 0.3] },
  surprised: { lift: 0.5, f: 3, l: [-0.4, 0.5], r: [0.4, 0.5] },
  excited: { lift: 0.9, f: 3.2, alt: 1 },
  happy: { lift: 0.6, f: 1.8, alt: 1, kick: 0.3 },
  laughing: { lift: 0.4, f: 4 },
  angry: { lift: 0.8, f: 2.2, rOnly: 1, l: [-0.3, 0], r: [0.3, 0] },
  sad: { lift: 0, f: 0, l: [0.3, 0], r: [-0.3, 0] },
  scared: { lift: 0, f: 0, sx: 0.18, l: [0.5, 0], r: [-0.5, 0] },
  suspicious: { lift: 0.3, f: 0.6, alt: 1, kick: 0.4 },
  confused: { lift: 0, f: 0, l: [0, 0], r: [-0.6, 0] },
  curious: { lift: 0.5, f: 1.4, rOnly: 1 },
  proud: { lift: 0, f: 0, l: [-0.5, 0.3], r: [0.5, 0.3] },
  shy: { lift: 0.5, f: 1.6, rOnly: 1, l: [0.4, 0], r: [-0.4, 0] },
  unimpressed: { lift: 0.5, f: 2.4, lOnly: 1 },
  sleepy: { lift: 0, f: 0, l: [0.2, 0], r: [-0.2, 0] },
  injured: { lift: 0, f: 0, l: [0, 0], r: [0.3, -0.6], sx: 0.06 },
};

export type Idle = { bx?: number; by?: number };

/** Per-expression idle personality in whole cells; `Fh` = frames since the face appeared. */
export const IDLE: Record<string, (Fh: number) => Idle> = {
  attentive: (Fh) => ({ by: Fh > 2 ? -1 : 0 }),
  surprised: (Fh) => ({ by: Fh < 3 ? -1 : 0 }),
  excited: (Fh) => ({ by: Fh % 6 < 2 ? -1 : 0 }),
  happy: (Fh) => ({ by: Fh % 12 < 3 ? -1 : 0 }),
  laughing: (Fh) => ({ by: Math.floor(Fh / 3) % 2 ? 0 : -1 }),
  proud: (Fh) => ({ by: Fh > 2 ? -1 : 0 }),
  angry: (Fh) => ({ bx: Fh % 12 < 4 ? (Fh % 2 ? 1 : -1) : 0 }),
  sad: (Fh) => ({ by: Fh > 6 ? 1 : 0 }),
  scared: (Fh) => ({ bx: Fh % 4 < 2 ? 0 : Fh % 8 < 4 ? 1 : -1 }),
  suspicious: (Fh) => ({ bx: Math.floor(Fh / 12) % 2 ? 1 : -1 }),
  confused: (Fh) => ({ bx: Math.floor(Fh / 9) % 2 ? 1 : -1 }),
  curious: (Fh) => ({ bx: Fh > 3 ? 1 : 0, by: Fh % 18 < 3 ? -1 : 0 }),
  shy: (Fh) => ({ bx: Fh > 3 ? -1 : 0, by: Fh > 3 ? 1 : 0 }),
  sleepy: (Fh) => ({ by: Math.floor(Fh / 12) % 2 }),
  injured: (Fh) => ({ by: Fh % 12 < 6 ? 1 : 0 }),
  neutral: (Fh) => ({ by: Fh % 48 > 44 ? -1 : 0 }),
};
