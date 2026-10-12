/**
 * The 35 newer expressions: an eye pattern (8 × 12 grid of the eye region, `o` = hole, or a base
 * face) plus a per-frame `fx` that moves hands, shifts the body, swaps the eyes or adds props.
 * Whole cells, 12 fps, `F` = frames since the face appeared. Verbatim from `noe-bot-film.jsx`.
 */

import { hh, lerpF, rot90 } from "./motion";
import {
  COLS,
  EAR_POSE,
  type EarShape,
  FILLED,
  gridPx,
  ORIGINAL_FACES,
  type Px,
  ROW_FACE_PX,
} from "./pixels";
import {
  type Cell,
  cel,
  EYES_BIG,
  EYES_HALF,
  EYES_SHUT,
  type Glyph,
  HEART3,
  HEART5,
  pat,
  RING,
  RING_PATH,
  SPIRAL,
  STAR3,
  STAR5,
  spr,
} from "./sprites";

export type Vec2 = readonly [number, number];
export type Limbs = { l: Vec2; r: Vec2 };

export type Fx = {
  props?: Cell[];
  glyphs?: Glyph[];
  hands?: Limbs;
  legs?: Limbs;
  px?: Px | null;
  bx?: number;
  by?: number;
  noEars?: boolean;
  noBlink?: boolean;
  noLegs?: boolean;
};

export type ExprSection =
  | "Affection"
  | "Playful"
  | "Unwell"
  | "Distress"
  | "Relief";

export type Expr = {
  sec: ExprSection;
  grid?: readonly string[];
  base?: string;
  ear?: readonly [EarShape, EarShape];
  noBlink?: true;
  noEars?: true;
  fx?: (F: number) => Fx;
};

const WINK_GRID = [
  "............",
  "............",
  "...oo.......",
  "...oo.......",
  "...oo..ooo..",
  "...oo.......",
  "............",
  "............",
];
const ZANY_GRID = [
  "............",
  "..ooo.......",
  "..ooo.......",
  "..ooo...o...",
  "..ooo.......",
  "............",
  "............",
  "............",
];
const BLANK_GRID = (): string[][] =>
  Array.from({ length: 8 }, () => "............".split(""));
const join = (g: string[][]): string[] => g.map((r) => r.join(""));

export const EXPRS: Record<string, Expr> = {
  // ---- Affection
  wink: {
    sec: "Affection",
    ear: ["normal", "pointy"],
    grid: WINK_GRID,
    fx: (F) => ({
      props: Math.floor(F / 6) % 2 ? [cel(12, 1, "W"), cel(13, 0, "G")] : [],
    }),
  },
  "in-love": {
    sec: "Affection",
    ear: ["tall", "tall"],
    noBlink: true,
    base: "blank",
    fx: (F) => {
      const big = F % 12 < 3 || (F % 12 >= 5 && F % 12 < 7);
      const els = big
        ? [...pat(HEART5, 1, 4, "W"), ...pat(HEART5, 8, 4, "W")]
        : [...pat(HEART3, 2, 4, "W"), ...pat(HEART3, 9, 4, "W")];
      const age = F % 18;
      if (age < 12)
        els.push(...pat(HEART3, 15 + ((age >> 2) % 2), 2 - (age >> 2), "P"));
      return { props: els };
    },
  },
  "star-struck": {
    sec: "Affection",
    ear: ["tall", "tall"],
    noBlink: true,
    base: "blank",
    fx: (F) => {
      const a = Math.floor(F / 4) % 2 === 0;
      const els = a
        ? [...pat(STAR5, 1, 4, "W"), ...pat(STAR5, 8, 4, "W")]
        : [...pat(STAR3, 2, 4, "W"), ...pat(STAR3, 9, 4, "W")];
      (
        [
          [-2, 1],
          [15, 2],
          [-1, 9],
          [14, 10],
          [6, -2],
        ] as const
      ).forEach(([x, y], i) => {
        if ((F + i * 3) % 8 < 3) els.push(cel(x, y, i % 2 ? "G" : "W"));
      });
      return { props: els };
    },
  },
  "blowing-kiss": {
    sec: "Affection",
    ear: ["normal", "pointy"],
    grid: WINK_GRID,
    fx: (F) => {
      const els: Cell[] = [];
      [0, 14].forEach((s0) => {
        const age = F - 8 - s0;
        if (age >= 0 && age < 14)
          els.push(...pat(HEART3, 15 + (age >> 1), 5 - (age >> 2), "P"));
      });
      return {
        hands: { l: [0, 0], r: F % 14 < 8 ? [0, 2] : [2, 0] },
        props: els,
      };
    },
  },
  hug: {
    sec: "Affection",
    ear: ["pointy", "pointy"],
    base: "happy",
    fx: (F) => {
      const open = F < 14;
      const els: Cell[] = [];
      if (open) {
        const wv = F % 6 < 3 ? 0 : 1;
        (
          [
            [-1, 4],
            [-2, 3 + wv],
          ] as const
        ).forEach(([x, y]) => {
          els.push(cel(x, y, "P"), cel(13 - x, y, "P"));
        });
      } else if (F >= 16) {
        (
          [
            [2, -2],
            [11, -2],
          ] as const
        ).forEach(([x, y], i) => {
          if ((F + i * 4) % 10 < 6)
            els.push(...pat(HEART3, x - 1, y - ((F >> 2) % 2), "P"));
        });
      }
      return {
        by: open ? 0 : F % 8 < 4 ? 0 : 1,
        hands: open ? { l: [-3, -3], r: [3, -3] } : { l: [1, 1], r: [-1, 1] },
        props: els,
      };
    },
  },
  angelic: {
    sec: "Affection",
    ear: ["normal", "normal"],
    base: "happy",
    noBlink: true,
    fx: (F) => ({
      props: spr(
        ["..WWWW..", "WW....WW", "..WWWW.."],
        3,
        -4 + (Math.floor(F / 12) % 2),
      ),
    }),
  },
  // ---- Playful
  zany: {
    sec: "Playful",
    ear: ["tall", "droop"],
    grid: ZANY_GRID,
    fx: (F) => {
      const flip = Math.floor(F / 8) % 2;
      const g = ZANY_GRID.map((r) =>
        flip ? r.split("").reverse().join("") : r,
      );
      return { px: gridPx(g), bx: [0, 1, 0, -1][Math.floor(F / 3) % 4] };
    },
  },
  smirk: {
    sec: "Playful",
    ear: ["flat", "pointy"],
    grid: [
      "............",
      "............",
      "............",
      ".........oo.",
      "....oo...oo.",
      "....oo...oo.",
      "............",
      "............",
    ],
    fx: () => ({ hands: { l: [1, 2], r: [0, 0] } }),
  },
  "eye-roll": {
    sec: "Playful",
    ear: ["flat", "flat"],
    noBlink: true,
    fx: (F) => {
      const path = [
        [2, 3],
        [2, 2],
        [3, 1],
        [4, 0],
        [3, 0],
        [3, 0],
      ] as const;
      const i = F < 6 ? F : F < 18 ? 5 : Math.max(0, 5 - (F - 18));
      const [ox, oy] = path[Math.min(5, i)] ?? [3, 0];
      const g = BLANK_GRID();
      (
        [
          [ox, oy],
          [ox + 1, oy],
          [ox, oy + 1],
          [ox + 1, oy + 1],
        ] as const
      ).forEach(([x, y]) => {
        const row = g[y];
        if (row) {
          row[x] = "o";
          row[x + 5] = "o";
        }
      });
      return { px: gridPx(join(g)), hands: { l: [0, 1], r: [0, 1] } };
    },
  },
  shush: {
    sec: "Playful",
    ear: ["normal", "normal"],
    base: "lookR",
    fx: (F) => ({
      hands: { l: [0, 0], r: [1, -1] },
      props:
        F >= 4 ? [...spr(["WWWWW", "WWWWW"], 16, -1), cel(16, 1, "W")] : [],
      glyphs:
        F >= 4
          ? [
              {
                x: 16.5,
                y: 0.62,
                text: "shh.",
                fill: "D",
                fontSize: 1.5,
                textLength: 4,
              },
            ]
          : [],
    }),
  },
  salute: {
    sec: "Playful",
    ear: ["tall", "tall"],
    base: "attentive",
    fx: (F) => ({
      hands: { l: [0, 0], r: [1, -4] },
      legs: { l: [1, 0], r: [-1, 0] },
      props: F >= 2 ? [cel(14, 3, "P"), cel(13, 4, "P")] : [],
    }),
  },
  devilish: {
    sec: "Playful",
    noEars: true,
    base: "angry",
    fx: (F) => {
      const fl = Math.floor(F / 6) % 2;
      const els = (
        [
          [3, 0],
          [2, -1],
          [1, -2],
        ] as const
      ).flatMap(([x, y]) => [cel(x, y, "P"), cel(13 - x, y, "P")]);
      els.push(
        cel(14, 9, "P"),
        cel(15, 8 + fl, "P"),
        cel(16, 7 + fl, "P"),
        cel(17, 7 + fl, "P"),
        cel(17, 6 + fl, "P"),
      );
      if (F % 8 < 2) els.push(cel(0, -1, "W"));
      return { props: els };
    },
  },
  cowboy: {
    sec: "Playful",
    noEars: true,
    base: "happy",
    fx: (F) => {
      const tip = F % 18 >= 12 ? -1 : 0;
      const els = [
        ...spr(["GGGGGG"], 4, -2 + tip),
        ...spr(["GKKKKKKG"], 3, -1 + tip),
        ...spr(["GGGGGGGGGGGGGGGG"], -1, 0 + tip),
      ];
      return { hands: { l: [0, 0], r: tip ? [1, -5] : [0, 0] }, props: els };
    },
  },
  // ---- Unwell
  sick: {
    sec: "Unwell",
    ear: ["droop", "droop"],
    grid: EYES_HALF,
    fx: (F) => {
      const lvl = Math.min(3, Math.floor(F / 6));
      const els = [
        cel(12, 8, "G"),
        cel(13, 8, "G"),
        cel(14, 8, "G"),
        cel(15, 8, "G"),
        cel(16, 8, "P"),
      ];
      for (let i = 0; i < lvl; i++) els.push(cel(15 - i, 8, "P"));
      const d = F % 12;
      if (d < 8) els.push(cel(1, 2 + d, "W"));
      return { hands: { l: [0, 1], r: [0, 1] }, props: els };
    },
  },
  sneeze: {
    sec: "Unwell",
    ear: ["normal", "normal"],
    fx: (F) => {
      const pre = F < 10;
      const squint = F >= 10 && F < 16;
      const burst = F >= 16 && F < 20;
      const px = gridPx(pre ? EYES_BIG : squint ? EYES_HALF : EYES_SHUT);
      const els: Cell[] = [];
      if (burst) {
        for (let i = 0; i < 8; i++) {
          els.push(
            cel(
              14 + Math.floor(hh(i + F) * 6),
              4 + Math.floor(hh(i * 3 + F) * 6),
              i % 2 ? "W" : "G",
            ),
          );
        }
      }
      if (F >= 22) els.push(...spr(["WW", "WW"], 14, 5));
      return {
        px,
        bx: burst ? -1 : 0,
        by: squint && F % 2 ? -1 : 0,
        hands: { l: [0, 0], r: F >= 22 ? [1, 0] : [0, 0] },
        props: els,
      };
    },
  },
  hot: {
    sec: "Unwell",
    ear: ["droop", "droop"],
    grid: EYES_HALF,
    fx: (F) => {
      const els: Cell[] = [];
      [0, 13].forEach((x, k) => {
        const d = (F + k * 5) % 10;
        if (d < 8) els.push(cel(x, 2 + d, "W"));
      });
      [3, 6, 9].forEach((x, i) => {
        const o = (Math.floor(F / 3) + i) % 2;
        els.push(cel(x + o, -2, "G"), cel(x + 1 - o, -1, "G"));
      });
      return { hands: { l: [0, 0], r: [1, F % 4 < 2 ? -1 : -3] }, props: els };
    },
  },
  cold: {
    sec: "Unwell",
    ear: ["inward", "inward"],
    grid: EYES_SHUT,
    fx: (F) => {
      const els = (
        [
          [2, 1],
          [11, 1],
          [1, 2],
          [12, 2],
          [5, 12],
          [8, 12],
        ] as const
      ).map(([x, y]) => cel(x, y, "W"));
      for (let i = 0; i < 8; i++) {
        const y = -2 + ((F + i * 5) % 16);
        els.push(cel(-6 + Math.floor(hh(i) * 26), y, i % 2 ? "W" : "G"));
      }
      return { bx: F % 2, hands: { l: [1, 1], r: [-1, 1] }, props: els };
    },
  },
  woozy: {
    sec: "Unwell",
    ear: ["droop", "pointy"],
    grid: [
      "............",
      "............",
      "............",
      "........o...",
      "...oo...o...",
      "...oo...o...",
      "........o...",
      "............",
    ],
    fx: (F) => {
      const els: Cell[] = [];
      const b = F % 16;
      if (b < 8) els.push(cel(14 + (b >> 2), 2 - (b >> 1), "G"));
      return {
        bx: [0, 0, 1, 1, 0, 0, -1, -1][Math.floor(F / 3) % 8],
        props: els,
      };
    },
  },
  "mind-blown": {
    sec: "Unwell",
    ear: ["tall", "tall"],
    base: "surprised",
    fx: (F) => {
      const boom = F >= 8 && F < 24;
      const els: Cell[] = [];
      let px: number[] | null = null;
      if (boom) {
        px = ROW_FACE_PX.surprised.slice();
        for (let c = 0; c < COLS; c++) {
          px[c] = 0;
          px[COLS + c] = 0;
          px[2 * COLS + c] = c === 0 || c === 13 ? 0 : (px[2 * COLS + c] ?? 0);
        }
        const age = F - 8;
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI;
          const rr = Math.min(age, 6);
          els.push(
            cel(
              6 + Math.round(Math.cos(a) * rr * 1.3),
              1 - Math.round(Math.sin(a) * rr * 0.6),
              i % 3 ? "P" : "W",
            ),
          );
        }
        if (age > 3)
          (
            [
              [3, -3],
              [6, -4],
              [9, -3],
              [5, -2],
              [8, -2],
            ] as const
          ).forEach(([x, y]) => {
            els.push(cel(x, y, "G"));
          });
      }
      return { px, noEars: boom, bx: F < 8 && F % 2 ? 1 : 0, props: els };
    },
  },
  melting: {
    sec: "Unwell",
    noEars: true,
    noBlink: true,
    fx: (F) => {
      const L = Math.min(5, Math.floor(F / 4));
      const base = gridPx([
        "............",
        "............",
        "....o..o....",
        "....o..o....",
        "....o..o....",
        "....o..o....",
        "............",
        "............",
      ]);
      const px: number[] = new Array(168).fill(0);
      for (let r = 0; r < 12; r++)
        for (let c = 0; c < COLS; c++)
          if (base[r * COLS + c] && r + L <= 11) px[(r + L) * COLS + c] = 1;
      for (let r = 0; r < 12; r++)
        for (let c = 0; c < COLS; c++) {
          if (
            !base[r * COLS + c] &&
            r >= 4 &&
            r <= 7 &&
            c > 0 &&
            c < 13 &&
            r + L <= 11
          )
            px[(r + L) * COLS + c] = 0;
        }
      const els: Cell[] = [];
      for (let c = -L; c <= 13 + L; c++) els.push(cel(c, 11, "P"));
      if (L < 3) {
        for (const c of [3, 4, 9, 10]) els.push(cel(c, L, "P"));
      }
      return {
        px,
        props: els,
        hands: { l: [-L, Math.min(5, L + 1)], r: [L, Math.min(5, L + 1)] },
        legs: { l: [-1, 0], r: [1, 0] },
      };
    },
  },
  shaking: {
    sec: "Unwell",
    ear: ["tall", "tall"],
    base: "surprised",
    fx: (F) => {
      const els: Cell[] = [];
      if (F % 2) {
        for (const y of [3, 5, 7]) els.push(cel(-2, y, "G"), cel(15, y, "G"));
      }
      return { bx: [-1, 0, 1, 0][F % 4], props: els };
    },
  },
  // ---- Distress
  worried: {
    sec: "Distress",
    ear: ["inward", "inward"],
    grid: [
      "............",
      "............",
      "....o..o....",
      "...oo..oo...",
      "...oo..oo...",
      "...oo..oo...",
      "............",
      "............",
    ],
    fx: (F) => {
      const d = F % 14;
      return {
        hands: { l: [1, F % 6 < 3 ? 1 : 2], r: [-1, F % 6 < 3 ? 2 : 1] },
        props: d < 6 ? [cel(12, 1 + d, "W")] : [],
      };
    },
  },
  pleading: {
    sec: "Distress",
    ear: ["droop", "droop"],
    grid: EYES_BIG,
    noBlink: true,
    fx: (F) => ({
      props: [
        cel(3, 3, "W"),
        cel(8, 3, "W"),
        ...(F % 8 < 4 ? [cel(5, 6, "G"), cel(10, 6, "G")] : []),
      ],
      hands: { l: [1, 2], r: [-1, 2] },
    }),
  },
  "holding-tears": {
    sec: "Distress",
    ear: ["droop", "droop"],
    grid: EYES_BIG,
    noBlink: true,
    fx: (F) => {
      const w = F % 6 < 3;
      return {
        props: [
          cel(3, 3, "W"),
          cel(8, 3, "W"),
          ...[3, 4, 5, 8, 9, 10].map((c, i) =>
            cel(c, w && i % 3 === 1 ? 5 : 6, "W"),
          ),
        ],
      };
    },
  },
  sobbing: {
    sec: "Distress",
    ear: ["droop", "droop"],
    noBlink: true,
    grid: [
      "............",
      "............",
      "............",
      "...o....o...",
      "..o.o..o.o..",
      "............",
      "............",
      "............",
    ],
    fx: (F) => {
      const els: Cell[] = [];
      [2, 11].forEach((c, k) => {
        for (let r = 7; r <= 12; r++) {
          if ((r + F) % 3 !== 0)
            els.push(
              cel(
                k ? c + 1 + (r > 10 ? 1 : 0) : c - 1 - (r > 10 ? 1 : 0),
                r,
                "W",
              ),
            );
        }
      });
      const pw = Math.min(4, F >> 3);
      for (let i = 1; i <= pw; i++)
        els.push(cel(-1 - i, 12, "W"), cel(14 + i, 12, "W"));
      return { by: F % 6 < 3 ? 0 : 1, props: els };
    },
  },
  screaming: {
    sec: "Distress",
    ear: ["tall", "tall"],
    noBlink: true,
    grid: [
      "...oo..oo...",
      "...oo..oo...",
      "...oo..oo...",
      "...oo..oo...",
      "...oo..oo...",
      "...oo..oo...",
      "............",
      "............",
    ],
    fx: (F) => ({ bx: F % 2, hands: { l: [0, -2], r: [0, -2] } }),
  },
  weary: {
    sec: "Distress",
    ear: ["droop", "droop"],
    noBlink: true,
    grid: [
      "............",
      "............",
      "............",
      "..o......o..",
      "...o....o...",
      "..o......o..",
      "............",
      "............",
    ],
    fx: (F) => {
      const a = F % 18;
      return {
        by: 1,
        hands: { l: [0, 2], r: [0, 2] },
        props:
          a < 8
            ? [
                cel(15 + (a >> 2), 6 - (a >> 1), "G"),
                cel(16 + (a >> 2), 6 - (a >> 1), "G"),
              ]
            : [],
      };
    },
  },
  yawning: {
    sec: "Distress",
    ear: ["normal", "normal"],
    grid: EYES_SHUT,
    noBlink: true,
    fx: (F) => {
      const up = F >= 4 && F < 16;
      return {
        by: up ? -1 : 0,
        hands: up ? { l: [-1, -4], r: [1, -4] } : { l: [0, 0], r: [0, 0] },
        props: up && F > 8 ? [cel(6, 7, "W")] : [],
      };
    },
  },
  huffing: {
    sec: "Distress",
    ear: ["splay", "splay"],
    base: "angry",
    fx: (F) => {
      const ph = F % 12;
      const side = Math.floor(F / 12) % 2;
      const els: Cell[] = [];
      if (ph < 6) {
        for (let i = 0; i <= Math.min(3, ph); i++) {
          const x = side ? 14 + i : -1 - i;
          els.push(cel(x, 7 - (i > 1 ? 1 : 0), "G"));
          if (i > 1) els.push(cel(x, 8, "G"));
        }
      }
      return { by: ph < 2 ? -1 : 0, props: els };
    },
  },
  // ---- Relief
  pensive: {
    sec: "Relief",
    ear: ["droop", "droop"],
    noBlink: true,
    grid: [
      "............",
      "............",
      "............",
      "............",
      "..o......o..",
      "...oo..oo...",
      "............",
      "............",
    ],
    fx: () => ({ by: 1, hands: { l: [0, 2], r: [0, 2] } }),
  },
  relieved: {
    sec: "Relief",
    ear: ["normal", "normal"],
    noBlink: true,
    grid: [
      "............",
      "............",
      "............",
      "..o......o..",
      "...oo..oo...",
      "............",
      "............",
      "............",
    ],
    fx: (F) => {
      const els: Cell[] = [];
      const d = F - 4;
      if (d >= 0 && d < 10) els.push(cel(-1 - (d >> 2), 1 + d, "W"));
      const p = F - 14;
      if (p >= 0 && p < 8)
        els.push(
          cel(14 + (p >> 1), 7 - (p >> 2), "G"),
          cel(15 + (p >> 1), 7 - (p >> 2), "G"),
        );
      return { by: F >= 14 && F < 20 ? 1 : 0, props: els };
    },
  },
  joy: {
    sec: "Relief",
    ear: ["pointy", "pointy"],
    base: "laughing",
    fx: (F) => {
      const a = F % 6;
      const els: Cell[] = [];
      (
        [
          [1, 5],
          [0, 5],
          [-1, 6],
          [-2, 7],
          [-3, 8],
          [-3, 9],
        ] as const
      )
        .slice(a, a + 2)
        .forEach(([x, y]) => {
          els.push(cel(x, y, "W"), cel(13 - x, y, "W"));
        });
      return { by: F % 6 < 2 ? -1 : 0, props: els };
    },
  },
  party: {
    sec: "Relief",
    noEars: true,
    base: "happy",
    fx: (F) => {
      const els = spr(["..W..", ".GPG.", ".PGP.", "GPGPG"], 4, -3);
      const ext = Math.min(5, F % 18);
      for (let i = 0; i < ext; i++) els.push(cel(15 + i, 5, i % 2 ? "P" : "W"));
      if (ext < 5) els.push(cel(15 + ext, 4, "W"));
      (
        [
          [-3, 0],
          [17, -2],
          [-1, -3],
          [19, 2],
        ] as const
      ).forEach(([x, y], i) => {
        if ((F + i * 4) % 10 < 5)
          els.push(
            cel(
              x,
              y + ((F >> 2) % 2),
              (["P", "W", "G"] as const)[i % 3] ?? "P",
            ),
          );
      });
      return { hands: { l: [0, 0], r: [1, 0] }, props: els };
    },
  },
  nerd: {
    sec: "Relief",
    ear: ["normal", "normal"],
    noBlink: true,
    fx: (F) => {
      const up = F % 18 >= 12 ? -1 : 0;
      const g = BLANK_GRID();
      for (let r = 2 + up; r <= 4 + up; r++) {
        const row = g[r];
        if (row)
          [2, 3, 8, 9].forEach((c) => {
            row[c] = "o";
          });
      }
      const els = [cel(6, 4 + up, "K"), cel(7, 4 + up, "K")];
      [2, 8].forEach((x0) => {
        const y0 = 3 + up;
        for (let x = x0; x <= x0 + 3; x++)
          els.push(cel(x, y0, "K"), cel(x, y0 + 4, "K"));
        for (let y = y0; y <= y0 + 4; y++)
          els.push(cel(x0, y, "K"), cel(x0 + 3, y, "K"));
        els.push(cel(x0 + 1, y0 + 1, "W"));
      });
      return {
        px: gridPx(join(g)),
        hands: { l: [0, 0], r: up ? [0, -2] : [0, 0] },
        props: els,
      };
    },
  },
  monocle: {
    sec: "Relief",
    ear: ["flat", "tall"],
    noBlink: true,
    grid: [
      "............",
      "............",
      ".......ooo..",
      ".......ooo..",
      "..ooo..ooo..",
      ".......ooo..",
      "............",
      "............",
    ],
    fx: (F) => {
      const els = spr(
        [".WWW.", "W...W", "W...W", "W...W", "W...W", ".WWW."],
        7,
        3,
      );
      (
        [
          [11, 9],
          [11, 10],
          [12, 11],
          [13, 11],
        ] as const
      ).forEach(([x, y]) => {
        els.push(cel(x, y, "G"));
      });
      if (F % 12 < 2) els.push(cel(8, 4, "W"));
      return { props: els };
    },
  },
};

/** The 35 newer faces in the film's order. */
export const EXPR_KEYS: readonly string[] = Object.keys(EXPRS);

/** Every face's pixels: the brand sheet's 18, the film's helpers, and the 35 newer faces. */
export const FACES: Record<string, Px> = (() => {
  const all: Record<string, Px> = { ...ROW_FACE_PX };
  for (const [key, d] of Object.entries(EXPRS)) {
    all[key] = d.grid
      ? gridPx(d.grid)
      : (ROW_FACE_PX[(d.base ?? "neutral") as keyof typeof ROW_FACE_PX] ??
        FILLED);
    if (d.ear) EAR_POSE[key] = d.ear;
  }
  return all;
})();

/** Every face a Bot can wear, in the showcase's order: the sheet's 18, dizzy, cool, then the 35. */
export const ALL_FACES: readonly string[] = [...ORIGINAL_FACES, ...EXPR_KEYS];

/** Faces whose eyes are already closed or narrow never blink (film's list + each expr's own flag). */
const NO_BLINK_ORIGINALS = new Set([
  "sleepy",
  "scared",
  "shy",
  "proud",
  "unimpressed",
  "happy",
  "laughing",
]);
export const neverBlinks = (face: string): boolean =>
  NO_BLINK_ORIGINALS.has(face) || EXPRS[face]?.noBlink === true;

export type Rig = {
  strict?: boolean;
  bxCells?: boolean;
  bx?: number;
  by?: number;
  rot?: number;
  sq?: number;
  facePx?: Px | null;
  noBlink?: boolean;
  noEars?: boolean;
  noLegs?: boolean;
  hands?: Limbs;
  legs?: Limbs;
  eyes?: string | null;
  bodyFill?: "W" | null;
  props?: Cell[];
  glyphs?: Glyph[];
};

/** The rig for a newer expression `t` seconds into its hold. */
export const exprRig = (key: string, t: number): Rig => {
  const d = EXPRS[key];
  if (!d) return {};
  const F = Math.floor(t * 12);
  const r = d.fx ? d.fx(F) : {};
  return {
    strict: true,
    bxCells: true,
    bx: r.bx ?? 0,
    by: r.by ?? 0,
    facePx: r.px ?? null,
    noBlink: d.noBlink || r.noBlink,
    noEars: d.noEars || r.noEars,
    noLegs: r.noLegs,
    hands: r.hands,
    legs: r.legs,
    props: r.props,
    glyphs: r.glyphs,
  };
};

/** Dizzy: spirals for eyes that spin, a ring of stars overhead, the body swaying a cell. */
export const dizzyRig = (t: number): Rig => {
  const F = Math.floor(t * 12);
  const k = Math.floor(F / 3) % 4;
  let L: readonly string[] = SPIRAL;
  let R: readonly string[] = SPIRAL;
  for (let i = 0; i < k; i++) L = rot90(L);
  for (let i = 0; i < (4 - k) % 4; i++) R = rot90(R);
  const px = FILLED.slice();
  L.forEach((row, ry) => {
    row.split("").forEach((ch, rx) => {
      if (ch === "o") px[(4 + ry) * COLS + 2 + rx] = 0;
    });
  });
  R.forEach((row, ry) => {
    row.split("").forEach((ch, rx) => {
      if (ch === "o") px[(4 + ry) * COLS + 8 + rx] = 0;
    });
  });
  const s1 = RING_PATH[F % RING_PATH.length] ?? [0, 0];
  const s2 = RING_PATH[(F + 7) % RING_PATH.length] ?? [0, 0];
  const els = [
    ...spr(RING, 2, -3),
    cel(2 + s1[0], -3 + s1[1], "W"),
    cel(2 + s2[0], -3 + s2[1], "W"),
  ];
  return {
    strict: true,
    bxCells: true,
    bx: [0, 1, 0, -1][Math.floor(F / 4) % 4],
    by: 0,
    facePx: px,
    noBlink: true,
    props: els,
  };
};

/** Cool: sunglasses drop into place over a filled face, a glint sliding along them. */
export const coolRig = (t: number): Rig => {
  const F = Math.floor(t * 12);
  const y = lerpF(F, [
    [0, -1],
    [5, 4],
  ]);
  const els = spr(["DDDDDDDDDD", ".DDD..DDD."], 2, y);
  if (F % 18 >= 12)
    els.push(cel([2, 3, 4, 8, 9, 10][(F % 18) - 12] ?? 2, y + 1, "W"));
  return {
    strict: true,
    bxCells: true,
    bx: 0,
    by: F >= 8 && Math.floor(F / 6) % 2 ? 1 : 0,
    facePx: FILLED,
    noBlink: true,
    props: els,
  };
};
