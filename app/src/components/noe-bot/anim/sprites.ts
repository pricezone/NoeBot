/**
 * Props and effects as cells.
 *
 * The film draws every prop as `<rect>`s in one of six inks. Here a prop is a list of `Cell`s
 * whose `fill` is the ink's token, resolved to a colour only when the frame is drawn, so the same
 * sprite works in the design's own palette (rose on near-black) and inside an avatar (the face in
 * the scheme's ink on its background).
 */

/** P body · D ink/background · W paper · G line · K key (dark parts) · S dim · X glitch white. */
export type Ink = "P" | "D" | "W" | "G" | "K" | "S" | "X";

export type Cell = {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: Ink;
  opacity?: number;
};

export type Glyph = {
  x: number;
  y: number;
  text: string;
  fill: Ink;
  fontSize: number;
  textLength?: number;
  weight?: 500;
  anchor?: "middle";
};

export type Art = { cells: Cell[]; glyphs?: Glyph[] };

/** One whole cell; the film's 1.06 overlap keeps neighbours seamless under `crispEdges`. */
export const CELL = 1.06;

export const cel = (x: number, y: number, fill: Ink, opacity?: number): Cell =>
  opacity === undefined
    ? { x, y, w: CELL, h: CELL, fill }
    : { x, y, w: CELL, h: CELL, fill, opacity };

export type Colour = (
  rx: number,
  ry: number,
  ch: string,
) => Ink | null | undefined;

const INKS: ReadonlySet<string> = new Set(["P", "D", "W", "G", "K", "S", "X"]);
const inkOf = (ch: string): Ink | null => (INKS.has(ch) ? (ch as Ink) : null);

/** A pattern of ink letters (`.` = nothing) placed with its top-left at `(x, y)`. */
export const spr = (
  pat: readonly string[],
  x: number,
  y: number,
  col?: Colour,
): Cell[] => {
  const out: Cell[] = [];
  pat.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx] ?? ".";
      if (ch === ".") continue;
      const f = col ? col(rx, ry, ch) : inkOf(ch);
      if (!f) continue;
      out.push(cel(x + rx, y + ry, f));
    }
  });
  return out;
};

/** The `o` cells of a hole grid, drawn in one ink at `(x, y)` — eyes drawn as props. */
export const pat = (
  rows: readonly string[],
  x: number,
  y: number,
  ink: Ink,
): Cell[] => {
  const out: Cell[] = [];
  rows.forEach((row, ry) => {
    row.split("").forEach((c, rx) => {
      if (c === "o") out.push(cel(x + rx, y + ry, ink));
    });
  });
  return out;
};

/** The six-key terminal keyboard at row `y`; keys 0–5 alternate with dark gaps, pressed keys go paper. */
export const keyboard = (pressed: readonly number[], y = 10): Cell[] => {
  const els: Cell[] = [];
  for (let x = 1; x <= 12; x++) {
    const k = (x - 1) >> 1;
    const key = (x - 1) % 2 === 0;
    els.push(cel(x, y, key ? (pressed.includes(k) ? "W" : "S") : "K"));
  }
  return els;
};

export const SPIRAL = [".oo.", "o..o", "o.oo", ".o.."] as const;
export const RING = ["..SSSSS..", "SS.....SS", "..SSSSS.."] as const;
export const RING_PATH: readonly (readonly [number, number])[] = [
  [2, 0],
  [3, 0],
  [4, 0],
  [5, 0],
  [6, 0],
  [7, 1],
  [8, 1],
  [6, 2],
  [5, 2],
  [4, 2],
  [3, 2],
  [2, 2],
  [1, 1],
  [0, 1],
];
export const MINI = [".P.P.", "PPPPP", "P.P.P", "PPPPP", ".P.P."] as const;
export const MINI_BLINK = [
  ".P.P.",
  "PPPPP",
  "PPPPP",
  "PPPPP",
  ".P.P.",
] as const;
export const HEART_B = [
  ".PP.PP.",
  "PPPPPPP",
  "PPPPPPP",
  ".PPPPP.",
  "..PPP..",
  "...P...",
] as const;
export const HEART_S = [".P.P.", "PPPPP", "PPPPP", ".PPP.", "..P.."] as const;
/** A euro note: 7 × 3, grey corner marks, an arch window on the left; the € glyph is drawn over it. */
export const BILL = ["GWWWWWG", "WGWWWWW", "GWWWWWG"] as const;
export const MUG = [".WWW", "WWWW", ".WWW"] as const;
export const BUB: Record<number, readonly [readonly string[], number, number]> =
  {
    1: [["WW", "WW"], 6, 8],
    2: [[".WW.", "WWWW", "WWWW", ".WW."], 5, 7],
    3: [["..WW..", ".WWWW.", "WWWWWW", "WWWWWW", ".WWWW.", "..WW.."], 4, 6],
    4: [
      [
        "..WWWW..",
        ".WWWWWW.",
        "WWWWWWWW",
        "WWWWWWWW",
        "WWWWWWWW",
        "WWWWWWWW",
        ".WWWWWW.",
        "..WWWW..",
      ],
      3,
      5,
    ],
  };
export const WORDS = ["HI", "OLÁ", "HOLA", "CIAO", "ΓΕΙΑ", "HALLO"] as const;
export const NOTE = [".##", ".#.", "##."] as const;

export const EYES_BIG = [
  "............",
  "..ooo..ooo..",
  "..ooo..ooo..",
  "..ooo..ooo..",
  "..ooo..ooo..",
  "............",
  "............",
  "............",
] as const;
export const EYES_HALF = [
  "............",
  "............",
  "............",
  "............",
  "...oo..oo...",
  "...oo..oo...",
  "............",
  "............",
] as const;
export const EYES_SHUT = [
  "............",
  "............",
  "............",
  "............",
  "..ooo..ooo..",
  "............",
  "............",
  "............",
] as const;
export const HEART5 = [".o.o.", "ooooo", ".ooo.", "..o.."] as const;
export const HEART3 = ["o.o", "ooo", ".o."] as const;
export const STAR5 = ["..o..", "ooooo", ".ooo.", ".o.o."] as const;
export const STAR3 = [".o.", "ooo", ".o."] as const;

/** A euro note with its glyph. */
export const euro = (x: number, y: number): Art => ({
  cells: spr(BILL, x, y),
  glyphs: [
    {
      x: x + 4.5,
      y: y + 2.05,
      text: "€",
      fill: "P",
      fontSize: 1.9,
      weight: 500,
      anchor: "middle",
    },
  ],
});
