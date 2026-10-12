/**
 * Full-body actions and states: what the bot does (walk, search, type…) and what it is in (repair,
 * servers, success…). Each is a function of local time `t` (seconds since it began) and a blend
 * weight `w` (0 → 1 over the first 0.3 s, so hands, legs and props ease in). Terminal mode uses
 * whole cells at 12 fps; HD mode, where the film differs, moves by sub-cells. Verbatim from
 * `noe-bot-film.jsx` with the HD deltas of `noe-bot-film-hd.jsx`.
 */

import type { Limbs, Rig } from "./exprs";
import { clamp, hh, jumpAt, lerpF, MOTION, mix2, path, vel } from "./motion";
import { FILLED, ROW_FACE_PX } from "./pixels";
import {
  BUB,
  type Cell,
  cel,
  euro,
  type Glyph,
  HEART_B,
  HEART_S,
  type Ink,
  keyboard,
  MINI,
  MINI_BLINK,
  MUG,
  NOTE,
  spr,
  WORDS,
} from "./sprites";

/** The showcase drew one cell as 30 px; its pixel-based offsets are converted to cells with this. */
const DESIGN_P = 30;

export type Mode = "terminal" | "hd";

/** A sub-cell rectangle (HD props), in cells. */
export const rect = (
  x: number,
  y: number,
  w: number,
  h: number,
  fill: Ink,
  opacity?: number,
): Cell =>
  opacity === undefined ? { x, y, w, h, fill } : { x, y, w, h, fill, opacity };

const withOpacity = (cells: Cell[], opacity: number): Cell[] =>
  opacity >= 1
    ? cells
    : cells.map((c) => ({ ...c, opacity: (c.opacity ?? 1) * opacity }));

export type ActFn = (t: number, w: number, mode: Mode) => Rig;

const WALK = [
  [0, 0],
  [0.3, 0],
  [2.0, 340],
  [3.2, 340],
  [4.6, -300],
  [4.9, -300],
  [5.7, 0],
] as const;
const SEARCH = [
  [0, 0],
  [0.3, 0],
  [1.6, -5],
  [3.3, 4.5],
  [5.4, 4.5],
  [6.6, 0],
] as const;
const ITEM_X = 20.5;

const walk: ActFn = (t) => {
  const amp = clamp(Math.abs(vel(t, WALK)) / 180, 0, 1);
  const s = Math.sin(2 * Math.PI * 2.4 * t) * amp;
  const rot = clamp(vel(t, WALK) / 120, -1, 1) * 4;
  return {
    bx: path(t, WALK) / DESIGN_P,
    by: -Math.abs(s) * 0.3,
    rot,
    legs: {
      l: [s * 0.3, -Math.max(0, s) * 0.9],
      r: [-s * 0.3, -Math.max(0, -s) * 0.9],
    },
    hands: {
      l: [-s * 0.4, -0.4 - Math.max(0, -s) * 0.5],
      r: [s * 0.4, -0.4 - Math.max(0, s) * 0.5],
    },
  };
};

const jump: ActFn = (t) => {
  const j = jumpAt(t - 0.5, 3.0, 0) ??
    jumpAt(t - 2.0, 2.4, 360) ??
    jumpAt(t - 3.6, 2.0, 0) ?? { by: 0, sq: 0, rot: 0, air: 0, crouch: 0 };
  return {
    by: j.by,
    sq: j.sq,
    rot: j.rot,
    legs: {
      l: mix2([0, 0], [-0.4, -0.8], j.air),
      r: mix2([0, 0], [0.4, -0.8], j.air),
    },
    hands: {
      l: mix2(mix2([0, 0], [0.3, 1.2], j.crouch), [-0.8, -3], j.air),
      r: mix2(mix2([0, 0], [-0.3, 1.2], j.crouch), [0.8, -3], j.air),
    },
  };
};

const study: ActFn = (t, w, mode) => {
  const eyes =
    t < 4.9
      ? (["readL", "reading", "readR"][Math.floor(((t % 1.6) / 1.6) * 3)] ??
        null)
      : null;
  if (mode === "hd") {
    const y = 7.2 + (1 - w) * 3;
    const els: Cell[] = [
      rect(1.8, y, 5.1, 3.2, "W"),
      rect(7.1, y, 5.1, 3.2, "W"),
    ];
    [0.7, 1.4, 2.1].forEach((dy, i) => {
      els.push(
        rect(2.5, y + dy, 3.6, 0.22, "G"),
        rect(7.8, y + dy, i === 2 ? 2.2 : 3.6, 0.22, "G"),
      );
    });
    [1.6, 3.2, 4.4].forEach((ft) => {
      const u = (t - ft) / 0.4;
      if (u <= 0 || u >= 1) return;
      const wd = 5.1 * Math.cos(Math.PI * MOTION.drift(u));
      els.push(
        rect(Math.min(7, 7 + wd), y - 0.25, Math.abs(wd), 3.5, "W", 0.9),
      );
    });
    return {
      by: Math.sin(2 * Math.PI * 0.4 * t) * 0.08,
      eyes,
      hands: { l: [0.9, 2.6], r: [-0.9, 2.6] },
      props: withOpacity(els, w),
    };
  }
  const els =
    w > 0.5 ? spr(["WWWWW.WWWWW", "WGGGW.WGGGW", "WGGWW.WGGGW"], 1, 8) : [];
  if (w > 0.5) {
    [1.6, 3.2, 4.4].forEach((ft) => {
      const u = Math.floor((t - ft) * 12);
      if (u < 0 || u > 5) return;
      const x = [10, 8, 6, 5, 3, 1][u] ?? 1;
      for (let r = 7; r <= 10; r++) els.push(cel(x, r, r === 7 ? "G" : "W"));
    });
  }
  return {
    by: Math.sin(2 * Math.PI * 0.4 * t) * 0.08,
    eyes,
    hands: { l: [1, 3], r: [-1, 3] },
    props: els,
  };
};

const search: ActFn = (t, w, mode) => {
  const X = path(t, SEARCH);
  const v = vel(t, SEARCH);
  const amp = clamp(Math.abs(v) / 5, 0, 1);
  const s = Math.sin(2 * Math.PI * 2.2 * t);
  const found = path(t, [
    [3.5, 0],
    [3.8, 1],
  ]);
  const lift = path(t, [
    [4.2, 0],
    [4.6, 1],
    [5.3, 1],
    [5.7, 0],
  ]);
  const crouch = 0.5 * (1 - found * 0.6);
  const sweep =
    Math.sin(2 * Math.PI * 0.8 * t) * 1.3 * (1 - clamp((t - 3.0) / 0.3, 0, 1));
  const legs: Limbs = {
    l: [0, -Math.max(0, s) * 0.6 * amp],
    r: [0, -Math.max(0, -s) * 0.6 * amp],
  };
  if (mode === "hd") {
    const ox = 14.5 + sweep;
    const oy = 7.9 - crouch - lift * 2.2;
    const off = X * w;
    const gy = 12.1 - crouch * w;
    const els: Cell[] = [];
    const item = ITEM_X - off;
    const itemUnder =
      ITEM_X - off >= 1 - 0.3 && ITEM_X - off <= 3 && lift < 0.5;
    els.push(rect(item, gy - 0.45, 0.45, 0.45, "P"));
    els.push(rect(1, 1, 2, 2, "D", 0.85));
    if (itemUnder) els.push(rect(1.4, 1.4, 1.2, 1.2, "P"));
    if (found > 0.5 && Math.floor(t * 6) % 2 === 0) {
      els.push(
        rect(item - 0.6, gy - 1.2, 0.3, 0.3, "W"),
        rect(item + 0.8, gy - 1.5, 0.3, 0.3, "W"),
      );
    }
    [".##.", "#..#", "#..#", ".##."].forEach((row, ry) => {
      row.split("").forEach((ch, rx) => {
        if (ch === "#") els.push(cel(rx, ry, "W"));
      });
    });
    els.push(rect(1, 1, 2, 2, "W", 0.12), rect(-0.85, -0.85, 0.9, 0.9, "W"));
    return {
      bx: X,
      by: crouch - Math.abs(s) * 0.12 * amp,
      sq: 0.35 * (1 - found * 0.6),
      rot: 0,
      legs,
      hands: { l: [0.6, 2.2 - lift * 3], r: [ox - 1.7 - 13, oy - 1.7 - 5] },
      props: withOpacity(els, w),
    };
  }
  const gx = Math.round(14.5 + sweep);
  const gy = Math.round(7.9 - crouch - lift * 2.2);
  const Xc = Math.round(X);
  const cb = Math.round(crouch);
  const els: Cell[] = [];
  if (w > 0.5) {
    const ix = Math.round(ITEM_X - Xc);
    const iy = 11 - cb;
    const under = ix >= gx + 1 && ix <= gx + 2 && lift < 0.5;
    els.push(cel(ix, iy, "P"));
    els.push(...spr(["DD", "DD"], gx + 1, gy + 1, () => (under ? "P" : "D")));
    els.push(
      ...spr([".WW.", "W..W", "W..W", ".WW."], gx, gy),
      cel(gx - 1, gy - 1, "W"),
    );
    if (found > 0.5 && Math.floor(t * 6) % 2 === 0)
      els.push(cel(ix - 1, iy - 1, "W"), cel(ix + 1, iy - 2, "W"));
  }
  return {
    bxCells: true,
    bx: Xc,
    by: cb,
    legs,
    hands: { l: [1, 2 - Math.round(lift * 3)], r: [gx - 2 - 13, gy - 2 - 5] },
    props: els,
  };
};

const keyX = (k: number): number => 0.6 + k * 2.15;

const type: ActFn = (t, w, mode) => {
  if (mode === "hd") {
    const typing = t < 2.3 ? 1 : t < 3.0 ? 0 : t < 4.2 ? 1.35 : 0;
    const on = typing > 0 ? 1 : 0;
    const sp = typing || 1;
    const kl = Math.floor(t * 6 * sp) % 3;
    const kr = 3 + (Math.floor(t * 5.3 * sp + 0.5) % 3);
    const hl = on * Math.max(0, Math.sin(2 * Math.PI * 6 * sp * t));
    const hr = on * Math.max(0, Math.sin(2 * Math.PI * 5.3 * sp * t + 1.7));
    const rest = path(t, [
      [2.2, 0],
      [2.45, 1],
      [2.9, 1],
      [3.1, 0],
      [4.1, 0],
      [4.4, 1],
    ]);
    const y = 9.4 + (1 - w) * 3;
    const els = [0, 1, 2, 3, 4, 5].map((k) => {
      const down = on && ((k === kl && hl < 0.25) || (k === kr && hr < 0.25));
      return rect(keyX(k), y + (down ? 0.15 : 0), 1.85, 0.9, down ? "W" : "K");
    });
    return {
      by: Math.sin(2 * Math.PI * 1.2 * t) * 0.06,
      hands: {
        l: mix2([keyX(kl) + 0.4, 3.3 - hl * 0.8], [0.4, 1.4], rest),
        r: mix2([keyX(kr) + 0.4 - 13, 3.3 - hr * 0.8], [-0.2, -1.6], rest),
      },
      props: withOpacity(els, w),
    };
  }
  const F = Math.floor(t * 12);
  const typing = t < 2.3 ? 1 : t < 3.0 ? 0 : t < 4.2 ? 2 : 0;
  const per = typing === 2 ? 2 : 3;
  const kl = Math.floor(F / per) % 3;
  const kr = 3 + (Math.floor(F / per + 1) % 3);
  const dl = !!typing && Math.floor(F / per) % 2 === 0;
  const dr = !!typing && !dl;
  const hands: Limbs = typing
    ? { l: [1 + 2 * kl, dl ? 3 : 2], r: [1 + 2 * kr - 13, dr ? 3 : 2] }
    : { l: [0, 1], r: [0, -2] };
  return {
    hands,
    props: w > 0.5 ? keyboard([dl ? kl : -1, dr ? kr : -1]) : [],
  };
};

const game: ActFn = (t, w, mode) => {
  const won = t >= 4.5;
  if (mode === "hd") {
    const wk = won ? MOTION.pop((t - 4.5) / 0.35) : 0;
    const intense =
      clamp((t - 2.2) / 0.6, 0, 1) * (1 - clamp((t - 4.0) / 0.3, 0, 1));
    const rate = 1 + intense * 0.6;
    const pL = Math.max(0, Math.sin(2 * Math.PI * 5.2 * rate * t));
    const pR = Math.max(0, Math.sin(2 * Math.PI * 4.3 * rate * t + 1.9));
    const steer = won ? 0 : Math.sin(2 * Math.PI * (0.6 + intense * 0.5) * t);
    const jolt = won ? 0 : (pL + pR) * 0.06 * (1 + intense);
    const drop = won ? MOTION.enter((t - 4.5) / 0.4) : 0;
    const cy = 8.1 + jolt + (1 - w) * 3 + drop * 1.6;
    const op = w * (1 - drop);
    const dir = Math.floor(t * 3 * rate) % 4;
    const dp = (
      [
        [5.0, 0.25],
        [5.5, 0.75],
        [5.0, 1.25],
        [4.5, 0.75],
      ] as const
    )[dir] ?? [5, 0.25];
    const btnA = pR > 0.6;
    const btnB = pL > 0.7 && intense > 0;
    const els: Cell[] = [
      rect(3.1, cy - 0.4, 1.4, 2.8, "W"),
      rect(9.5, cy - 0.4, 1.4, 2.8, "W"),
      rect(4.4, cy, 5.2, 2, "W"),
      rect(4.5, cy + 0.75, 1.5, 0.5, "K"),
      rect(5.0, cy + 0.25, 0.5, 1.5, "K"),
    ];
    if (pL > 0.5) els.push(rect(dp[0], cy + dp[1], 0.5, 0.5, "P"));
    els.push(
      rect(7.9, cy + 0.35, 0.6, 0.6, btnB ? "K" : "P"),
      rect(8.8, cy + 1.05, 0.6, 0.6, btnA ? "K" : "P"),
    );
    return {
      bx: won ? 0 : (steer * 40) / DESIGN_P,
      by: won
        ? -0.8 * Math.sin(Math.PI * clamp((t - 4.5) / 0.5, 0, 1))
        : jolt * 0.5,
      rot: 0,
      hands: {
        l: mix2([3.4, 3.1 + jolt - pL * 0.45], [-0.8, -2.5], wk),
        r: mix2([-3.4, 3.1 + jolt - pR * 0.45], [0.8, -2.5], wk),
      },
      legs: {
        l: [
          0,
          won
            ? -0.7 * wk
            : -intense * Math.max(0, Math.sin(2 * Math.PI * 3 * t)) * 0.5,
        ],
        r: [0, won ? -0.7 * wk : 0],
      },
      props: withOpacity(els, op),
    };
  }
  const F = Math.floor(t * 12);
  const wf = won ? Math.floor((t - 4.5) * 12) : -1;
  const intense = t > 2.2 && t < 4.0;
  const per = intense ? 2 : 3;
  const pL = !won && Math.floor(F / per) % 2 === 0;
  const pR = !won && Math.floor((F + 1) / (per + 1)) % 2 === 0;
  const sway = won
    ? 0
    : Math.round(
        Math.sin(2 * Math.PI * (intense ? 0.9 : 0.45) * t) *
          (intense ? 1 : 0.6),
      );
  const hop = won && wf < 5 ? -1 : 0;
  const tap = intense && Math.floor(F / 3) % 2 === 0 ? -1 : 0;
  let els: Cell[] = [];
  if (w > 0.5 && wf <= 5) {
    const cy = 8 + (won ? Math.min(2, wf >> 1) : 0);
    const dir = Math.floor(F / (per * 2)) % 4;
    const btn = Math.floor((F + 3) / ((per + 1) * 2)) % 2;
    const dp = (
      [
        [5, 0],
        [6, 1],
        [5, 1],
        [4, 1],
      ] as const
    )[dir] ?? [5, 0];
    const bt = (
      [
        [8, 0],
        [9, 1],
      ] as const
    )[btn] ?? [8, 0];
    els = spr(
      ["W......W", "WWKWWPWW", "WKKKWWPW", "W......W"],
      3,
      cy - 1,
      (rx, ry, ch) => {
        const x = 3 + rx;
        const y = ry - 1;
        if (pL && x === dp[0] && y === dp[1]) return "P";
        if (pR && x === bt[0] && y === bt[1]) return "K";
        return ch as Ink;
      },
    );
  }
  return {
    bxCells: true,
    bx: sway,
    by: hop,
    hands: won
      ? { l: [-1, -3], r: [1, -3] }
      : { l: [3, pL ? 2 : 3], r: [-3, pR ? 2 : 3] },
    legs: { l: [tap, hop], r: [0, hop] },
    props: els,
  };
};

const headphones = (dy: number, beatOn: boolean): Cell[] => {
  const els: Cell[] = [];
  for (let x = 3; x <= 10; x++) els.push(cel(x, -1 + dy, "W"));
  (
    [
      [1, 0],
      [2, 0],
      [0, 1],
    ] as const
  ).forEach(([x, y]) => {
    els.push(cel(x, y + dy, "W"), cel(13 - x, y + dy, "W"));
  });
  (
    [
      [-1, 0],
      [13, 1],
    ] as const
  ).forEach(([x0, side]) => {
    els.push(
      ...spr(
        side ? ["WW", "KW", "KW", "WW"] : ["WW", "WK", "WK", "WW"],
        x0,
        2 + dy,
      ),
    );
    if (beatOn)
      els.push(
        cel(side ? 15 : -2, 3 + dy, "W"),
        cel(side ? 15 : -2, 4 + dy, "W"),
      );
  });
  return els;
};

const music: ActFn = (t, w, mode) => {
  if (mode === "hd") {
    const beat = 0.6;
    const bp = (t % beat) / beat;
    const onBeat = Math.max(0, 1 - bp * 3);
    const groove =
      clamp((t - 0.9) / 0.4, 0, 1) * (1 - clamp((t - 5.5) / 0.3, 0, 1));
    const bar = Math.floor(t / beat) % 2;
    const sway = Math.sin((2 * Math.PI * t) / (beat * 4)) * 50 * groove;
    const on = path(t, [
      [0, 0],
      [0.6, 1],
    ]);
    const dy = Math.round((1 - on) * -3);
    const els = headphones(dy, groove > 0.5 && onBeat > 0.5);
    for (let n = 0; n < 9; n++) {
      const born = 1.0 + n * beat;
      const u = (t - born) / 1.2;
      if (u < 0 || u > 1) continue;
      const side = n % 2;
      const sc = 0.42;
      const x0 = side ? 14.6 : -2.4;
      const x = x0 + (side ? 1 : -1) * u * 1.6 + Math.sin(u * 7 + n) * 0.35;
      const y = 2 - u * 4;
      const op = Math.min(1, u * 6, (1 - u) * 3) * w;
      NOTE.forEach((row, ry) => {
        row.split("").forEach((ch, rx) => {
          if (ch === "#")
            els.push(
              rect(
                x + rx * sc,
                y + ry * sc,
                sc * 1.04,
                sc * 1.04,
                n % 3 === 0 ? "P" : "W",
                op,
              ),
            );
        });
      });
    }
    return {
      bx: sway / DESIGN_P,
      by: (-0.3 * onBeat + 0.1) * groove,
      sq: 0.5 * onBeat * groove,
      hands: {
        l: [-0.2, 0.8 - (bar ? onBeat : 0) * 1.2 * groove],
        r: [0.2, 0.8 - (bar ? 0 : onBeat) * 1.2 * groove],
      },
      legs: {
        l: [0, -(bar === 0 ? onBeat : 0) * 0.7 * groove],
        r: [0, -(bar === 1 ? onBeat : 0) * 0.7 * groove],
      },
      props: withOpacity(els, w),
    };
  }
  const F = Math.floor(t * 12);
  const beatF = Math.floor(t / 0.6);
  const inBeat = t % 0.6 < 0.17;
  const groove = t > 0.9 && t < 5.5;
  const bar = beatF % 2;
  let els: Cell[] = [];
  if (w > 0.5) {
    els = headphones(-3 + Math.min(3, F >> 1), groove && inBeat);
    for (let n = 0; n < 9; n++) {
      const age = t - (1.0 + n * 0.6);
      if (age < 0 || age > 0.95) continue;
      const side = n % 2;
      const a = Math.floor(age * 12);
      els.push(
        ...spr(
          [".WW", ".W.", "WW."],
          side ? 16 + (a >> 3) : -5 - (a >> 3),
          1 - (a >> 2),
          () => (n % 3 === 0 ? "P" : "W"),
        ),
      );
    }
  }
  return {
    bxCells: true,
    bx: groove ? ([0, 1, 0, -1][beatF % 4] ?? 0) : 0,
    by: groove && inBeat ? -1 : 0,
    hands: {
      l: [0, groove && inBeat && bar ? -1 : 1],
      r: [0, groove && inBeat && !bar ? -1 : 1],
    },
    legs: {
      l: [0, groove && inBeat && !bar ? -1 : 0],
      r: [0, groove && inBeat && bar ? -1 : 0],
    },
    props: els,
  };
};

// ===== Terminal-strict state suite: whole cells, 12 fps, nothing rotated, brand colours only =====

export type Run = {
  bx?: number;
  by?: number;
  hands?: Limbs;
  legs?: Limbs;
  props?: Cell[];
  glyphs?: Glyph[];
  facePx?: readonly number[];
  bodyFill?: "W" | null;
};

const flexRun = (F: number, charged: boolean): Run => {
  const p = F % 12 < 3 ? 1 : 0;
  const strike = charged && [0, 1, 3].includes(F % 12);
  const els: Cell[] = [];
  if (strike) {
    els.push(...spr(["..WW", ".WW.", "WWWW", ".WW.", "WW.."], 5, -4));
    els.push(cel(4, 0, "P"), cel(9, 0, "P"));
  }
  const fill: Ink = charged && F % 12 === 0 ? "W" : "P";
  const arm = p
    ? ["PP..", "PP..", "PPP.", "PPPP", ".PPP"]
    : ["PP..", "PP..", "PP..", "PPPP", ".PPP"];
  const mir = arm.map((r) => r.split("").reverse().join(""));
  els.push(
    ...spr(arm, -3, 2 - p, (_rx, _ry, ch) => (ch === "P" ? fill : null)),
  );
  els.push(
    ...spr(mir, 13, 2 - p, (_rx, _ry, ch) => (ch === "P" ? fill : null)),
  );
  return {
    bodyFill: charged && F % 12 === 0 ? "W" : null,
    hands: { l: [-3, -3 - p], r: [3, -3 - p] },
    props: els,
  };
};

const coffeeRun = (
  F: number,
  SIPS: readonly number[],
  base: number,
  e: number,
): Run => {
  const sipOn = SIPS.some((f) => F >= f && F < f + 5);
  const cups = base + SIPS.filter((f) => F >= f + 5).length;
  const [dx, dy] = sipOn ? [0, -2] : [1, 0];
  const hx = 13 + dx;
  const hy = 5 + dy;
  const mx = hx + 1;
  const my = hy - 1;
  const els: Cell[] = [];
  (
    [
      [-6, 9],
      [-11, 9],
      [-16, 9],
      [-9, 5],
      [-14, 5],
      [-12, 1],
      [-19, 5],
      [-19, 9],
    ] as const
  )
    .slice(0, cups)
    .forEach(([x, y]) => {
      els.push(...spr(MUG, x, y, (_rx, _ry, ch) => (ch === "W" ? "S" : null)));
    });
  els.push(...spr(MUG, mx, my));
  const slow = e > 0 ? 1 : 2;
  [0, 1].forEach((k) => {
    const age = Math.floor((F + k * 4 * slow) / slow) % 8;
    if (age < 6)
      els.push(
        cel(mx + 1 + k * 2 + ((age >> 1) % 2), my - 1 - (age >> 1), "G"),
      );
  });
  if (e) {
    (
      [
        [-2, 1],
        [15, 9],
        [2, -3],
        [11, -3],
        [-2, 7],
        [19, 0],
      ] as const
    ).forEach(([x, y], i) => {
      if ((F + i * 5) % 8 < 2)
        els.push(
          ...spr(["W.", ".W", "W."], x, y, () => ((F + i) % 2 ? "W" : "P")),
        );
    });
  }
  const jit = e && F % 8 < 4 ? ([0, 1, 0, -1][F % 4] ?? 0) : 0;
  const tap = e && F % 4 < 2 ? -1 : 0;
  return {
    bx: jit,
    hands: { l: [0, e ? (F % 4 < 2 ? -1 : 0) : 0], r: [dx, dy] },
    legs: { l: [0, tap], r: [0, e ? -1 - tap : 0] },
    props: els,
  };
};

export type FaceCue = readonly [number, string];

export type StateDef = {
  id: string;
  kind: "action" | "state";
  /** `[offset s, face]` from the start of the animation it belongs to. */
  faces: readonly FaceCue[];
  noEars?: true;
  noBlink?: true;
  /** A segment of a longer action (detective of search, turbo of type, wizard of sparkler). */
  partOf?: string;
  run: (F: number, mode: Mode) => Run;
};

const turboKeyboard = (F: number, mode: Mode): Cell[] => {
  const kl = F % 3;
  const kr = 3 + ((F + 1) % 3);
  const dl = F % 2 === 0;
  const dr = (F + 1) % 2 === 0;
  if (mode === "hd") {
    return [0, 1, 2, 3, 4, 5].map((k) => {
      const down = (k === kl && dl) || (k === kr && dr);
      return rect(
        keyX(k),
        9.4 + (down ? 0.15 : 0),
        1.85,
        0.9,
        down ? "W" : "K",
      );
    });
  }
  return keyboard([dl ? kl : -1, dr ? kr : -1]);
};

export const STATES: readonly StateDef[] = [
  // ---- 1. UI & system status
  {
    id: "writing",
    kind: "action",
    faces: [[0, "reading"]],
    run: (F) => {
      const n = clamp(Math.floor(F / 4), 0, 8);
      const line = n < 4 ? 0 : 1;
      const col = 1 + (Math.min(n, 7) % 4);
      const els = spr(["WWWWWW", "W....W", "WWWWWW", "W....W", "WWWWWW"], 4, 8);
      [0, 1].forEach((ln) => {
        for (let i = 0; i < 4; i++)
          els.push(cel(5 + i, 9 + ln * 2, ln * 4 + i < n ? "K" : "W"));
      });
      const cx = 4 + col;
      const cy = 9 + line * 2;
      const lift = n < 8 && F % 4 < 2 ? 0 : -1;
      if (n < 8)
        els.push(
          cel(cx, cy - 1 + lift, "D"),
          cel(cx, cy - 2 + lift, "K"),
          cel(cx, cy - 3 + lift, "G"),
        );
      return {
        by: -1,
        legs: { l: [-1, 0], r: [1, 0] },
        hands: { l: [3, 4], r: [cx + 1 - 13, cy - 4 + lift - 5] },
        props: els,
      };
    },
  },
  {
    id: "unplugged",
    kind: "state",
    faces: [[0, "sad"]],
    run: (F) => {
      const ph = F % 12;
      const plugX = ph < 6 ? 4 : ph < 9 ? 5 : 3;
      const els: Cell[] = [];
      for (let y = 11; y <= 12; y++)
        els.push(cel(plugX, y, "G"), cel(10, y, "G"));
      for (let x = -8; x < plugX; x++) els.push(cel(x, 12, "G"));
      for (let x = 11; x <= 21; x++) els.push(cel(x, 12, "G"));
      els.push(...spr(["KKW", "KK.", "KKW"], plugX, 8));
      els.push(...spr(["SK", "KK", "SK"], 9, 8));
      if (ph >= 6 && ph < 9) {
        els.push(cel(8, 7, F % 2 ? "W" : "P"));
        els.push(cel(7 + (F % 2), 10, "W"));
      }
      return { hands: { l: [plugX - 1, 3], r: [-2, 3] }, props: els };
    },
  },
  // ---- 2. Work & technical
  {
    id: "turbo",
    kind: "action",
    faces: [
      [5, "attentive"],
      [6.5, "excited"],
    ],
    partOf: "type",
    run: (F, mode) => {
      const els: Cell[] = [];
      const mon = [
        "KKKKKKKKKK",
        ...Array.from({ length: 6 }, () => "KDDDDDDDDK"),
        "KKKKKKKKKK",
      ];
      els.push(...spr(mon, -13, 1));
      for (let r = 0; r < 6; r++) {
        const L = r + Math.floor(F / 2);
        const len = 2 + Math.floor(hh(L) * 6);
        const ind = Math.floor(hh(L * 7) * 2);
        const c: Ink = hh(L * 3) > 0.7 ? "W" : "G";
        for (let i = 0; i < len && ind + i < 8; i++)
          els.push(cel(-12 + ind + i, 2 + r, c));
      }
      els.push(...spr(["KK"], -9, 9), ...spr(["KKKKKK"], -11, 10));
      els.push(...turboKeyboard(F, mode));
      const fa = F % 4 < 2;
      els.push(
        ...spr(
          fa ? [".P..P..P..", "PWPPWPPWPP"] : ["P..P..P..P", "PPWPPWPPWP"],
          -13,
          -1,
        ),
      );
      els.push(...spr([fa ? "PWP.PPWP.PWPP." : "P.PWPP.PWP.PPW"], 0, 12));
      for (let i = 0; i < 10; i++) {
        const age = (F - ((i * 3) % 12) + 120) % 12;
        if (age >= 6) continue;
        const a = hh(i + Math.floor(F / 12) * 10) * Math.PI;
        els.push(
          cel(
            6 + Math.round(Math.cos(a) * age * 1.4),
            10 - Math.round(Math.sin(a) * age),
            i % 2 ? "W" : "P",
          ),
        );
      }
      const hands: Limbs =
        mode === "hd"
          ? {
              l: [Math.round(0.6 + (F % 3) * 2.15 + 0.4), F % 2 === 0 ? 3 : 2],
              r: [
                Math.round(0.6 + (3 + ((F + 1) % 3)) * 2.15 + 0.4) - 13,
                (F + 1) % 2 === 0 ? 3 : 2,
              ],
            }
          : {
              l: [1 + 2 * (F % 3), F % 2 === 0 ? 3 : 2],
              r: [1 + 2 * (3 + ((F + 1) % 3)) - 13, F % 2 === 0 ? 2 : 3],
            };
      return { bx: 4, hands, props: els };
    },
  },
  {
    id: "terminal",
    kind: "action",
    faces: [[0, "side"]],
    run: (F) => {
      const win = [
        "KSSSKKKKKKKK",
        ...Array.from({ length: 8 }, () => "KDDDDDDDDDDK"),
        "KKKKKKKKKKKK",
      ];
      const els = spr(win, 16, 0);
      const lens = [6, 4, 7, 5];
      let n = F;
      lens.forEach((L, i) => {
        if (n < 0) return;
        els.push(cel(17, 2 + i * 2, "P"));
        const k = Math.min(L, n);
        for (let j = 0; j < k; j++)
          els.push(cel(19 + j, 2 + i * 2, j % 3 === 2 ? "W" : "G"));
        if (n < L && F % 6 < 3) els.push(cel(19 + k, 2 + i * 2, "W"));
        n -= L + 2;
      });
      return { bx: -4, hands: { l: [0, 0], r: [2, 0] }, props: els };
    },
  },
  {
    id: "repair",
    kind: "state",
    faces: [
      [0, "suspicious"],
      [1.5, "attentive"],
    ],
    noEars: true,
    run: (F) => {
      const up = Math.floor(F / 4) % 2;
      const dr = F % 4 < 2 ? 0 : 1;
      const els = [
        ...spr(["WWWWWW"], 4, -2),
        ...spr(["WWWGGWWW"], 3, -1),
        ...spr(["WWWWWWWWWWWW"], 1, 0),
      ];
      els.push(...spr(["G.G", "GGG", ".G.", ".G.", ".G."], -2, -1 - up));
      els.push(...spr([F % 2 ? "W" : "G", "W", "K", "K"], 14, 0 - dr));
      return { hands: { l: [-1, -1 - up], r: [1, -1 - dr] }, props: els };
    },
  },
  {
    id: "logs",
    kind: "action",
    faces: [
      [0, "reading"],
      [0.8, "lookR"],
      [2.4, "happy"],
    ],
    run: (F) => {
      const E = lerpF(F, [
        [0, 4],
        [20, 26],
      ]);
      const els: Cell[] = [];
      const items: [number, number][] = [];
      for (let x = 3; x <= E; x++)
        for (let r = 8; r <= 12; r++) {
          const txt =
            (r === 9 || r === 11) && x >= 5 && x <= E - 2 && (x + r) % 6 < 4;
          if (txt && (x + r) % 6 === 0) items.push([x, r]);
          els.push(cel(x, r, txt ? "G" : "W"));
        }
      items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const ticks = F >= 20 ? Math.floor((F - 20) / 2) : 0;
      items.slice(0, ticks).forEach(([x, r]) => {
        els.push(cel(x - 1, r, "P"));
      });
      els.push(
        ...spr(["K", "K", "K", "K", "K", "K"], 2, 7),
        ...spr(["S", "K", "K", "K", "K", "S"], E + 1, 7),
      );
      return { bx: -7, by: 0, hands: { l: [2, 3], r: [-11, 5] }, props: els };
    },
  },
  {
    id: "present",
    kind: "action",
    faces: [[0, "happy"]],
    run: (F) => {
      const card = [
        "KSSSKKKKKKK",
        "WWWWWWWWWWW",
        "WGGGGGWWWWW",
        "WGGGGGWKKKW",
        "WGGGGGWWWWW",
        "WWWWWWWWWWW",
        "WKKKKKKKWWW",
        "WWWWWWWPPPW",
        "WWWWWWWWWWW",
      ];
      const bob = Math.floor(F / 12) % 2 ? 0 : -1;
      const vis = card
        .slice(0, Math.min(card.length, F + 1))
        .map((row, i) =>
          i === 7 && F % 12 >= 6 ? row.replace(/P/g, "W") : row,
        );
      return {
        bx: -4,
        hands: { l: [0, 0], r: [2, bob] },
        props: spr(vis, 16, -1 + bob),
      };
    },
  },
  {
    id: "servers",
    kind: "state",
    faces: [[0, "proud"]],
    run: (F) => {
      const X = -13;
      const els: Cell[] = [];
      const cab = [
        "GGGGGGGGG",
        ...Array.from({ length: 9 }, () => "G.......G"),
        "GGGGGGGGG",
        "G.......G",
      ];
      els.push(...spr(cab, X, 0));
      [1, 4, 7].forEach((y, u) => {
        els.push(...spr(["SSSSSSS", "SKSKSKS"], X + 1, y));
        const busy = hh(Math.floor(F / 2) * 7 + u) > 0.35;
        els.push(cel(X + 6, y, busy ? "P" : "K"));
        els.push(cel(X + 7, y, F % 12 < 10 ? "W" : "S"));
        const bay = Math.floor(F / 3 + u) % 3;
        els.push(cel(X + 1 + bay * 2, y + 1, "W"));
      });
      for (let x = X + 9; x <= -1; x++)
        els.push(cel(x, 9, x === X + 9 + (F % (-X - 9)) ? "W" : "G"));
      return { bx: 4, hands: { l: [-2, 3], r: [0, 0] }, props: els };
    },
  },
  {
    id: "greeting",
    kind: "action",
    faces: [[0, "happy"]],
    run: (F) => {
      const els: Cell[] = [];
      const glyphs: Glyph[] = [];
      WORDS.forEach((wd, i) => {
        const age = F - (1 + i * 5);
        if (age < 0 || age >= 13) return;
        const wdt = wd.length + 2;
        const slot = i % 4;
        const x = slot % 2 ? 16 : -1 - wdt;
        const y = slot % 2 ? (slot < 2 ? -4 : 1) : slot < 2 ? -1 : 3;
        els.push(...spr(["W".repeat(wdt), "W".repeat(wdt)], x, y));
        els.push(cel(slot % 2 ? x : x + wdt - 1, y + 2, "W"));
        if (age > 0)
          glyphs.push({
            x: x + 1,
            y: y + 1.62,
            text: wd,
            fill: "D",
            fontSize: 1.5,
            weight: 500,
            textLength: wd.length,
          });
      });
      return {
        hands: { l: [0, 0], r: [1 + (Math.floor(F / 3) % 2), -3] },
        props: els,
        glyphs,
      };
    },
  },
  // ---- 3. Motion, power & celebration
  {
    id: "success",
    kind: "state",
    faces: [[0, "happy"]],
    run: (F) => {
      const X = 16;
      const Y = -3;
      const els: Cell[] = [];
      const disc = [
        "..WWWWW..",
        ".WWWWWWW.",
        "WWWWWWWWW",
        "WWWWWWWWW",
        "WWWWWWWWW",
        "WWWWWWWWW",
        "WWWWWWWWW",
        ".WWWWWWW.",
        "..WWWWW..",
      ];
      const grow = [
        ["W"],
        [".W.", "WWW", ".W."],
        [".WWW.", "WWWWW", "WWWWW", "WWWWW", ".WWW."],
      ];
      if (F < 3) {
        const g = grow[F] ?? ["W"];
        els.push(...spr(g, X + 4 - (g.length >> 1), Y + 4 - (g.length >> 1)));
      } else {
        els.push(...spr(disc, X, Y));
        const tick = [
          [1, 4],
          [2, 4],
          [2, 5],
          [3, 5],
          [3, 6],
          [4, 5],
          [4, 4],
          [5, 4],
          [5, 3],
          [6, 3],
          [6, 2],
          [7, 2],
        ] as const;
        tick
          .slice(0, Math.min(tick.length, (F - 3) * 2 + 2))
          .forEach(([x, y]) => {
            els.push(cel(X + x, Y + y, "P"));
          });
        const rim = [
          [4, -1],
          [9, 0],
          [10, 4],
          [9, 8],
          [4, 9],
          [-1, 8],
          [-2, 4],
          [-1, 0],
        ] as const;
        rim.forEach(([x, y], i) => {
          if ((Math.floor(F / 2) + i) % 4 === 0)
            els.push(cel(X + x, Y + y, i % 2 ? "G" : "W"));
        });
      }
      return {
        bx: -3,
        hands: { l: [-1, -3], r: [2, -3] },
        legs: { l: [0, F % 12 < 2 ? -1 : 0], r: [0, F % 12 < 2 ? -1 : 0] },
        props: els,
      };
    },
  },
  {
    id: "confetti",
    kind: "state",
    faces: [[0, "laughing"]],
    run: (F) => {
      const els: Cell[] = [];
      for (let i = 0; i < 44; i++) {
        const age = F - Math.floor(hh(i) * 18);
        const spd = 2 + (i % 2);
        if (age < 0) continue;
        const y = -2 + Math.floor(age / spd);
        if (y > 12) continue;
        els.push(
          cel(
            -14 + Math.floor(hh(i + 50) * 42) + ((Math.floor(age / 3) + i) % 2),
            y,
            (["P", "W", "G"] as const)[i % 3] ?? "P",
          ),
        );
      }
      const a = F % 6 < 3;
      return {
        hands: { l: [-1, a ? -3 : -2], r: [1, a ? -2 : -3] },
        props: els,
      };
    },
  },
  {
    id: "finish",
    kind: "state",
    faces: [[0, "proud"]],
    run: (F) => {
      const pump = Math.floor(F / 6) % 2 ? 0 : -1;
      const els: Cell[] = [];
      for (let y = -3 + pump; y <= 2 + pump; y++) els.push(cel(15, y, "G"));
      for (let j = 0; j < 6; j++)
        for (let r = 0; r < 4; r++) {
          const yo = (j + Math.floor(F / 3)) % 4 < 2 ? 0 : 1;
          els.push(cel(16 + j, -3 + pump + r + yo, (j + r) % 2 ? "W" : "K"));
        }
      return { bx: -3, hands: { l: [-1, -2], r: [2, -2 + pump] }, props: els };
    },
  },
  {
    id: "sparkler",
    kind: "action",
    faces: [[0, "happy"]],
    run: (F) => {
      const pth = [
        [1, -3],
        [2, -3],
        [2, -2],
        [2, -1],
        [1, -1],
        [1, -2],
      ] as const;
      const idx = Math.floor(F / 2) % 6;
      const [dx, dy] = pth[idx] ?? [1, -3];
      const hx = 13 + dx;
      const hy = 5 + dy;
      const els: Cell[] = [];
      for (let k = 4; k >= 1; k--) {
        const [px, py] = pth[(idx - k + 6) % 6] ?? [1, -3];
        els.push(cel(13 + px, 5 + py - 3, k > 2 ? "S" : "G"));
      }
      els.push(
        cel(hx, hy - 1, "G"),
        cel(hx, hy - 2, "G"),
        cel(hx, hy - 3, "W"),
      );
      for (let i = 0; i < 6; i++) {
        const ox = Math.round((hh(F * 13 + i) - 0.5) * 4);
        const oy = Math.round((hh(F * 17 + i) - 0.5) * 4);
        if (ox || oy)
          els.push(
            cel(hx + ox, hy - 3 + oy, (["W", "P", "G"] as const)[i % 3] ?? "W"),
          );
      }
      return { hands: { l: [0, 0], r: [dx, dy] }, props: els };
    },
  },
  {
    id: "barbell",
    kind: "action",
    faces: [
      [0, "angry"],
      [2.25, "proud"],
    ],
    run: (F) => {
      const r = F % 18;
      const y = lerpF(r, [
        [0, 8],
        [2, 8],
        [8, -2],
        [13, -2],
        [17, 8],
      ]);
      const els: Cell[] = [];
      for (let x = -1; x <= 14; x++) els.push(cel(x, y, "G"));
      els.push(
        ...spr(["WW", "WW", "WW"], -3, y - 1),
        ...spr(["WW", "WW", "WW"], 15, y - 1),
      );
      if (r >= 9 && r <= 12) els.push(cel(12, 1 + (r - 9), "W"));
      return {
        bx: r >= 9 && r < 13 && r % 2 ? 1 : 0,
        hands: { l: [0, y - 5], r: [0, y - 5] },
        legs: { l: [-1, 0], r: [1, 0] },
        props: els,
      };
    },
  },
  {
    id: "flex",
    kind: "action",
    faces: [[0, "proud"]],
    run: (F) => flexRun(F, false),
  },
  {
    id: "powered-up",
    kind: "state",
    faces: [[0, "proud"]],
    run: (F) => flexRun(F, true),
  },
  {
    id: "coffee",
    kind: "action",
    faces: [
      [0, "neutral"],
      [1.0, "proud"],
    ],
    run: (F) => coffeeRun(F, [6, 18, 27], 0, 0),
  },
  {
    id: "caffeinated",
    kind: "state",
    faces: [
      [0, "attentive"],
      [0.6, "excited"],
    ],
    run: (F) => coffeeRun(F, [2, 8, 14, 20, 26], 3, 1),
  },
  {
    id: "skate",
    kind: "action",
    faces: [[0, "excited"]],
    run: (F) => {
      const pts = [
        [0, 0],
        [2, 0],
        [10, 8],
        [12, 8],
        [28, -8],
        [36, 0],
      ] as const;
      const x = lerpF(F, pts);
      const dir = Math.sign(lerpF(F + 1, pts) - x);
      const els: Cell[] = [];
      for (let c = 1; c <= 12; c++) els.push(cel(c, 12, "G"));
      els.push(cel(3, 13, F % 2 ? "W" : "S"), cel(10, 13, F % 2 ? "S" : "W"));
      if (dir) {
        [3, 6, 9].forEach((r) => {
          const len = 3 + ((F + r) % 3);
          for (let k = 0; k < len; k++)
            els.push(
              cel(dir > 0 ? -2 - k : 15 + k, r, (k + F) % 2 ? "S" : "G"),
            );
        });
      }
      return {
        bx: x,
        by: -1,
        hands: { l: [-dir, 1], r: [-dir, 1] },
        props: els,
      };
    },
  },
  {
    id: "agents",
    kind: "state",
    faces: [[0, "proud"]],
    run: (F) => {
      const els: Cell[] = [];
      (
        [
          [-8, 7],
          [17, 7],
          [-15, 7],
          [24, 7],
        ] as const
      ).forEach(([x, y], k) => {
        const age = F - (2 + k * 5);
        if (age < 0) return;
        const hop = F - 24 - k * 2 >= 0 && F - 24 - k * 2 < 3 ? -1 : 0;
        const pattern = (F + k * 7) % 20 === 0 ? MINI_BLINK : MINI;
        els.push(
          ...spr(pattern, x, y + hop, (_rx, _ry, ch) =>
            age < 1 ? "W" : (ch as Ink),
          ),
        );
        if (age < 2) {
          const from = x < 0 ? -1 : 14;
          const to = x < 0 ? x + 5 : x - 1;
          for (let c = Math.min(from, to); c <= Math.max(from, to); c += 2)
            els.push(cel(c, 9, "S"));
        }
      });
      return { hands: { l: [-1, -1], r: [1, -1] }, props: els };
    },
  },
  // ---- 4. Accessories & expressive
  {
    id: "wizard",
    kind: "action",
    faces: [
      [3, "curious"],
      [4.5, "lookR"],
    ],
    noEars: true,
    partOf: "sparkler",
    run: (F) => {
      const tw: Ink = Math.floor(F / 6) % 2 ? "W" : "P";
      const sway = Math.floor(F / 12) % 2;
      const star = (_rx: number, _ry: number, ch: string): Ink =>
        ch === "P" ? tw : (ch as Ink);
      const els = [
        ...spr(["GGGGGGGGGGGG"], 1, 0),
        ...spr(["GGPGGGGG"], 3, -1, star),
        ...spr(["GGGGPG"], 4, -2, star),
        ...spr(["GGGG"], 5, -3),
        cel(7 + sway, -4, "G"),
      ];
      els.push(cel(15, 3, "G"), cel(16, 2, "G"), cel(17, 1, "W"));
      if (F % 2)
        (
          [
            [16, 0],
            [18, 0],
            [18, 2],
            [17, -1],
          ] as const
        ).forEach(([x, y], i) => {
          if (hh(F + i) > 0.4) els.push(cel(x, y, i % 2 ? "P" : "W"));
        });
      return { hands: { l: [0, 0], r: [1, -1] }, props: els };
    },
  },
  {
    id: "detective",
    kind: "action",
    faces: [[7, "suspicious"]],
    noEars: true,
    partOf: "search",
    run: (F) => {
      const gx = lerpF(F, [
        [0, 9],
        [14, 1],
        [18, 1],
        [32, 9],
        [36, 9],
      ]);
      const els = [
        ...spr(["GGGGGG"], 4, -2),
        ...spr(["GKKKKKKG"], 3, -1),
        ...spr(["GGGGGGGGGGGG"], 1, 0),
      ];
      const sp = ROW_FACE_PX.suspicious;
      const eye = (
        [
          [1, 1],
          [2, 1],
          [1, 2],
          [2, 2],
        ] as const
      ).some(([ox, oy]) => !sp[(3 + oy) * 14 + gx + ox]);
      els.push(
        ...spr(["DD", "DD"], gx + 1, 4, (rx, ry) =>
          eye ? (rx === 0 && ry === 0 ? "W" : "D") : "P",
        ),
      );
      els.push(
        ...spr([".WW.", "W..W", "W..W", ".WW."], gx, 3),
        cel(gx + 4, 7, "W"),
      );
      return { hands: { l: [0, 0], r: [gx + 5 - 13, 3] }, props: els };
    },
  },
  {
    id: "bubblegum",
    kind: "action",
    faces: [
      [0, "happy"],
      [1.42, "surprised"],
      [2.2, "laughing"],
    ],
    run: (F) => {
      const s: number | "pop" =
        F < 2
          ? 0
          : F < 5
            ? 1
            : F < 8
              ? 2
              : F < 12
                ? 3
                : F < 17
                  ? 4
                  : F < 19
                    ? "pop"
                    : F < 26
                      ? 0
                      : F < 29
                        ? 1
                        : F < 32
                          ? 2
                          : F < 34
                            ? "pop"
                            : 0;
      let els: Cell[] = [];
      if (s === "pop") {
        (
          [
            [6, 3],
            [11, 4],
            [12, 9],
            [10, 12],
            [3, 12],
            [1, 9],
            [2, 4],
          ] as const
        ).forEach(([x, y]) => {
          els.push(cel(x, y, "W"));
        });
      } else if (s) {
        const b = BUB[s];
        if (b) {
          const [pattern, x, y] = b;
          els = spr(pattern, x, y);
          if (s >= 2) els.push(cel(x + 1, y + 1, "G"));
        }
      }
      return { hands: { l: [0, 0], r: [0, 0] }, props: els };
    },
  },
  {
    id: "heart",
    kind: "action",
    faces: [
      [0, "shy"],
      [1.5, "happy"],
    ],
    run: (F) => {
      const beat = F % 12;
      const big = [0, 1, 4, 5].includes(beat);
      const els = big
        ? [...spr(HEART_B, 15, 1), cel(16, 2, "W")]
        : spr(HEART_S, 16, 2);
      for (let k = 0; k < 4; k++) {
        const age = F - (3 + k * 9);
        if (age < 0 || age >= 10) continue;
        els.push(
          ...spr(
            ["P.P", "PPP", ".P."],
            16 + (k % 2) * 3 + ((age >> 2) % 2),
            0 - (age >> 1),
          ),
        );
      }
      return { hands: { l: [0, 1], r: [1, 0] }, props: els };
    },
  },
  {
    id: "cash",
    kind: "action",
    faces: [
      [0, "happy"],
      [2.0, "proud"],
    ],
    run: (F) => {
      const pth = [
        [14, 0],
        [10, -2],
        [6, -3],
        [2, -2],
        [-2, 0],
        [-7, 3],
      ] as const;
      const els: Cell[] = [];
      const glyphs: Glyph[] = [];
      const note = (x: number, y: number) => {
        const e = euro(x, y);
        els.push(...e.cells);
        glyphs.push(...(e.glyphs ?? []));
      };
      let started = 0;
      let landed = 0;
      for (let f = 0; f < 3; f++) {
        const s = F - (4 + f * 10);
        if (s < 0) continue;
        started++;
        if (s >= 6) {
          landed++;
          continue;
        }
        const [x, y] = pth[s] ?? [14, 0];
        if (s % 2) els.push(...spr(["W", "W", "W"], x + 2, y));
        else note(x, y);
      }
      (
        [
          [15, 4],
          [16, 3],
          [17, 2],
        ] as const
      )
        .slice(0, 3 - started)
        .forEach(([x, y]) => {
          note(x, y);
        });
      for (let k = 0; k < landed; k++) note(-9, 6 - k);
      return { hands: { l: [-2, 0], r: [1, 0] }, props: els, glyphs };
    },
  },
];

export type Act = {
  id: string;
  kind: "action" | "state";
  /** Whole cells only (every state and the terminal-mode rendering of everything). */
  strict: boolean;
  faces: readonly FaceCue[];
  noEars?: true;
  noBlink?: true;
  partOf?: string;
  fn: ActFn;
};

/** Face cues of the seven original actions, from the film's script (offsets within the action). */
const ACT_FACES: Record<string, readonly FaceCue[]> = {
  walk: [
    [0, "attentive"],
    [2.1, "lookR"],
    [2.7, "lookL"],
    [3.2, "attentive"],
    [5.4, "happy"],
  ],
  jump: [
    [0, "excited"],
    [1.8, "surprised"],
    [3.3, "happy"],
  ],
  study: [
    [0, "reading"],
    [4.9, "curious"],
  ],
  search: [
    [0, "reading"],
    [3.6, "surprised"],
    [4.3, "happy"],
  ],
  type: [
    [0, "reading"],
    [2.3, "curious"],
    [3.0, "reading"],
    [4.2, "proud"],
  ],
  game: [
    [0, "attentive"],
    [2.2, "suspicious"],
    [4.0, "surprised"],
    [4.5, "excited"],
  ],
  music: [
    [0, "attentive"],
    [1.2, "happy"],
    [3.2, "proud"],
    [4.8, "happy"],
  ],
};

const ORIGINAL_ACTS: Record<string, ActFn> = {
  walk,
  jump,
  study,
  search,
  type,
  game,
  music,
};

export const ACTS: Record<string, Act> = (() => {
  const acts: Record<string, Act> = {};
  for (const [id, fn] of Object.entries(ORIGINAL_ACTS)) {
    acts[id] = {
      id,
      kind: "action",
      strict: false,
      faces: ACT_FACES[id] ?? [[0, "neutral"]],
      fn,
    };
  }
  for (const d of STATES) {
    acts[d.id] = {
      id: d.id,
      kind: d.kind,
      strict: true,
      faces: d.faces,
      noEars: d.noEars,
      noBlink: d.noBlink,
      partOf: d.partOf,
      fn: (t, w, mode) => {
        const r = d.run(Math.floor(t * 12), mode);
        return {
          strict: true,
          bxCells: true,
          bx: r.bx ?? 0,
          by: r.by ?? 0,
          rot: 0,
          hands: r.hands ?? { l: [0, 0], r: [0, 0] },
          legs: r.legs ?? { l: [0, 0], r: [0, 0] },
          noEars: d.noEars,
          noBlink: d.noBlink,
          facePx: r.facePx,
          bodyFill: r.bodyFill,
          props: w > 0.5 ? r.props : [],
          glyphs: w > 0.5 ? r.glyphs : [],
        };
      },
    };
  }
  return acts;
})();

/** A longer animation made of segments: `[act id, start s, end s]`. */
export type Segment = readonly [string, number, number];

/**
 * Each catalogue animation's segments and loop length, from the showcase's scene list: search is
 * the search action then the detective, type ends in turbo, sparkler ends as the wizard.
 */
export const SEQUENCES: Record<
  string,
  { segments: readonly Segment[]; duration: number }
> = {
  walk: { segments: [["walk", 0, 6]], duration: 6 },
  jump: { segments: [["jump", 0, 5]], duration: 5 },
  skate: { segments: [["skate", 0, 3]], duration: 3 },
  study: { segments: [["study", 0, 6]], duration: 6 },
  writing: { segments: [["writing", 0, 3]], duration: 3 },
  search: {
    segments: [
      ["search", 0, 7],
      ["detective", 7, 10],
    ],
    duration: 10,
  },
  type: {
    segments: [
      ["type", 0, 5],
      ["turbo", 5, 8],
    ],
    duration: 8,
  },
  logs: { segments: [["logs", 0, 3]], duration: 3 },
  present: { segments: [["present", 0, 3]], duration: 3 },
  terminal: { segments: [["terminal", 0, 3]], duration: 3 },
  greeting: { segments: [["greeting", 0, 3]], duration: 3 },
  game: { segments: [["game", 0, 6]], duration: 6 },
  music: { segments: [["music", 0, 6]], duration: 6 },
  coffee: { segments: [["coffee", 0, 3]], duration: 3 },
  barbell: { segments: [["barbell", 0, 3]], duration: 3 },
  flex: { segments: [["flex", 0, 3]], duration: 3 },
  sparkler: {
    segments: [
      ["sparkler", 0, 3],
      ["wizard", 3, 6],
    ],
    duration: 6,
  },
  bubblegum: { segments: [["bubblegum", 0, 3]], duration: 3 },
  heart: { segments: [["heart", 0, 3]], duration: 3 },
  cash: { segments: [["cash", 0, 3]], duration: 3 },
  repair: { segments: [["repair", 0, 3]], duration: 3 },
  servers: { segments: [["servers", 0, 3]], duration: 3 },
  "sub-agents": { segments: [["agents", 0, 3]], duration: 3 },
  caffeinated: { segments: [["caffeinated", 0, 3]], duration: 3 },
  "powered-up": { segments: [["powered-up", 0, 3]], duration: 3 },
  success: { segments: [["success", 0, 3]], duration: 3 },
  confetti: { segments: [["confetti", 0, 3]], duration: 3 },
  finish: { segments: [["finish", 0, 3]], duration: 3 },
  unplugged: { segments: [["unplugged", 0, 3]], duration: 3 },
};

export const FILLED_PX = FILLED;
