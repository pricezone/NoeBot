/**
 * One frame of the character, as a pure function of time.
 *
 * The port of the film's `Bot()`: given an animation, how long it has been playing and the face it
 * replaced, this returns the cells to draw (body, tears, props, ears, hands, legs, Z's) and the
 * transform to draw them under. Nothing is remembered between calls, so the same inputs always
 * give the same frame, which is what lets a clock drive it, a test pin it, and reduced motion show
 * its first frame.
 */

import { ACTS, SEQUENCES } from "./acts";
import { type Animation, IDLE_CUES, IDLE_SECONDS, segmentAt } from "./catalog";
import {
  coolRig,
  dizzyRig,
  exprRig,
  FACES,
  type Limbs,
  neverBlinks,
  type Rig,
} from "./exprs";
import { clamp, MOTION, mix2 } from "./motion";
import {
  COLS,
  EAR,
  EAR_LADDER,
  EAR_POSE,
  type EarShape,
  IDLE,
  isEar,
  isHand,
  isLeg,
  LEGS,
  POSES,
  type Px,
} from "./pixels";
import { CELL, type Cell, cel, type Glyph, spr } from "./sprites";

export type Mode = "terminal" | "hd";

export type FrameInput = {
  animation: Animation;
  /** Seconds since the animation started. */
  t: number;
  /** The face on screen before this animation began: the change-glitch and the ears step from it. */
  prevFace?: string;
  /** How many face holds came before; every third hold opens with a double blink. */
  holdIndex?: number;
  mode: Mode;
  /** Draw props and effects (sizes of 48 px and up). */
  props: boolean;
  /** Reduced motion: no blink, no glitch, no idle motion. */
  reduced?: boolean;
  /**
   * Where the eyes look, in whole cells: the holes move by this much inside the face, clamped to
   * the eye region, the way the film's glancing faces move them. For a mark whose eyes follow the
   * pointer.
   */
  eyeShift?: readonly [number, number];
  /**
   * A portrait rather than a moment: the face settled and centred, no blink, no glitch, no idle
   * shift, hands and legs at their pose, and the props that are its eyes kept whatever `props`
   * says. For a roster at rest, a picker tile, a 16 px icon.
   */
  still?: boolean;
};

/**
 * The frame of a face's own motion that makes its portrait: most faces are themselves at frame 0;
 * cool's sunglasses have dropped into place by frame 6, eye-roll's eyes are rolled up at 8, hug's
 * arms are back at its sides by 20.
 */
const PORTRAIT_FRAME: Record<string, number> = {
  cool: 6,
  "eye-roll": 8,
  hug: 20,
};

/** Whether a cell lies in the eye region (rows 2–9, cols 1–12), where a prop is an eye. */
const inEyeRegion = (c: Cell): boolean =>
  c.x >= 1 && c.x <= 12.5 && c.y >= 2 && c.y <= 9.5;

export type Frame = {
  cells: Cell[];
  glyphs: Glyph[];
  /** Outer offset in cells and rotation in degrees. */
  bx: number;
  by: number;
  rot: number;
  /** Inner bob in cells and squash scale, about the bottom centre. */
  bob: number;
  sx: number;
  sy: number;
  /** The expression on the face this frame. */
  face: string;
  /** The act playing, if any. */
  act: string | null;
};

type Cur = { key: string; at: number; end: number; prevKey: string; i: number };
type ActState = { name: string; t: number; w: number };
type Change = { f: number; key: string };

const REST_FACES: readonly (readonly [number, string])[] = [
  [0, "neutral"],
  [1.4, "sleepy"],
];
const REST_OUT = 4.4;

/** Ear override per act: music lifts both, walking and the start of the game keep them normal. */
const earKeyFor = (act: string | null, face: string): string =>
  act === "music"
    ? "earTall"
    : act === "walk" || (act === "game" && face === "attentive")
      ? "earNormal"
      : face;

/** Shape for an expression key on `side` (0 = left) at frame `F`. */
const earShape = (key: string, side: 0 | 1, F: number): EarShape => {
  if (key.startsWith("ear:")) return key.slice(4) as EarShape;
  if (key === "excited")
    return (Math.floor(F / 6) + side) % 2 ? "pointy" : "tall";
  if (key === "laughing") return Math.floor(F / 6) % 2 ? "pointy" : "normal";
  const pose = EAR_POSE[key];
  if (pose) return pose[side];
  return side === 0 && ((F % 96) + 96) % 96 < 2 ? "pointy" : "normal";
};

/** The left ear reacts one frame after a face change and the right two; big jumps climb the ladder. */
const earAt = (
  changes: readonly Change[],
  side: 0 | 1,
  F: number,
): EarShape => {
  const d = side + 1;
  let i = -1;
  changes.forEach((c, j) => {
    if (c.f + d <= F) i = j;
  });
  const first = changes[0];
  if (i < 0) return earShape(first?.key ?? "neutral", side, F);
  const current = changes[i];
  if (!current) return "normal";
  const target = earShape(current.key, side, F);
  if (i === 0) return target;
  const k = F - (current.f + d);
  const previous = changes[i - 1];
  const from = earShape(previous?.key ?? current.key, side, current.f + d - 1);
  const hf = EAR[from].h;
  const ht = EAR[target].h;
  if (Math.abs(ht - hf) < 2) return target;
  const step = ht > hf ? 1 : -1;
  const mids: EarShape[] = [];
  for (let h = hf + step; h !== ht; h += step)
    mids.push(EAR_LADDER[h] ?? target);
  return k < mids.length ? (mids[k] ?? target) : target;
};

const legOffset = (T: number, cur: Cur, side: "l" | "r"): [number, number] => {
  const a = LEGS[cur.prevKey] ?? LEGS.neutral;
  const b = LEGS[cur.key] ?? LEGS.neutral;
  if (!a || !b) return [0, 0];
  const k = MOTION.pop((T - cur.at) / 0.3);
  const pa = a[side] ?? [0, 0];
  const pb = b[side] ?? [0, 0];
  let dx = pa[0] + (pb[0] - pa[0]) * k;
  let dy = pa[1] + (pb[1] - pa[1]) * k;
  const phase = side === "r" && b.alt ? Math.PI : 0;
  const active = !(b.rOnly && side === "l") && !(b.lOnly && side === "r");
  const lift = a.lift + (b.lift - a.lift) * k;
  if (active && b.f) {
    const s = Math.sin(T * Math.PI * 2 * b.f + phase);
    dy -= Math.max(0, s) * lift;
    if (b.kick) dx += s * b.kick * (side === "l" ? -1 : 1);
  }
  const sx = (a.sx ?? 0) + ((b.sx ?? 0) - (a.sx ?? 0)) * k;
  if (sx) dx += Math.sin(T * Math.PI * 2 * 9 + (side === "r" ? 1.3 : 0)) * sx;
  return [dx, dy];
};

const handOffset = (T: number, cur: Cur, side: "l" | "r"): [number, number] => {
  const a = POSES[cur.prevKey] ?? POSES.neutral;
  const b = POSES[cur.key] ?? POSES.neutral;
  if (!a || !b) return [0, 0];
  const k = MOTION.pop((T - cur.at) / 0.34);
  const pa = a[side];
  const pb = b[side];
  let dx = pa[0] + (pb[0] - pa[0]) * k;
  let dy = pa[1] + (pb[1] - pa[1]) * k;
  const w = a.w + (b.w - a.w) * k;
  const f = b.f || a.f || 0.5;
  const phase = side === "r" && b.alt ? Math.PI : 0;
  const active = !b.rOnly || side === "r";
  if (active) dy += Math.sin(T * Math.PI * 2 * f + phase) * w;
  const sx = (a.sx ?? 0) + ((b.sx ?? 0) - (a.sx ?? 0)) * k;
  if (sx) dx += Math.sin(T * Math.PI * 2 * 9 + phase) * sx;
  return [dx, dy];
};

type Timeline = {
  cur: Cur;
  act: ActState | null;
  changes: Change[];
  bootIn: number;
  out: number;
};

/** Where in the animation we are at `t`: the face held, the act playing, and the ear change list. */
const timelineAt = (input: FrameInput, T: number): Timeline => {
  const { animation } = input;
  const prevFace = input.prevFace ?? null;
  const holdIndex = input.holdIndex ?? 0;
  const changesFrom = (
    cues: readonly (readonly [number, string])[],
    act: string | null,
  ): Change[] => {
    const list: Change[] = [];
    if (prevFace) list.push({ f: Number.NEGATIVE_INFINITY, key: prevFace });
    for (const [at, face] of cues) {
      const key = earKeyFor(act, face);
      const last = list[list.length - 1];
      if (last && last.key === key) continue;
      list.push({ f: Math.floor(at * 12), key });
    }
    return list;
  };
  const holdOf = (
    cues: readonly (readonly [number, string])[],
    end: number,
  ): Cur => {
    let idx = 0;
    cues.forEach((cue, j) => {
      if (T >= cue[0]) idx = j;
    });
    const cue = cues[idx] ?? [0, "neutral"];
    const next = cues[idx + 1];
    return {
      key: cue[1],
      at: cue[0],
      end: next ? next[0] : end,
      prevKey: idx > 0 ? (cues[idx - 1]?.[1] ?? cue[1]) : (prevFace ?? cue[1]),
      i: holdIndex + idx,
    };
  };

  switch (animation.kind) {
    case "face": {
      const cues = [[0, animation.id]] as const;
      return {
        cur: holdOf(cues, Number.POSITIVE_INFINITY),
        act: null,
        changes: changesFrom(cues, null),
        bootIn: Number.NEGATIVE_INFINITY,
        out: Number.POSITIVE_INFINITY,
      };
    }
    case "boot": {
      const cues = [[0, "original"]] as const;
      return {
        cur: holdOf(cues, Number.POSITIVE_INFINITY),
        act: null,
        changes: changesFrom(cues, null),
        bootIn: 0,
        out: Number.POSITIVE_INFINITY,
      };
    }
    case "rest":
      return {
        cur: holdOf(REST_FACES, REST_OUT + 1.6),
        act: null,
        changes: changesFrom(REST_FACES, null),
        bootIn: Number.NEGATIVE_INFINITY,
        out: REST_OUT,
      };
    case "idle": {
      // A looping pass of glances; from the second pass on, the face before the first cue is the
      // last glance's return to the original face, not whatever played before the idle began.
      const passStart =
        T - (((T % IDLE_SECONDS) + IDLE_SECONDS) % IDLE_SECONDS);
      const last = IDLE_CUES[IDLE_CUES.length - 1]?.[1] ?? "original";
      const cues: (readonly [number, string])[] = [
        ...(passStart > 0 ? [[passStart - 3.5, last] as const] : []),
        ...IDLE_CUES.map(([at, face]) => [passStart + at, face] as const),
      ];
      return {
        cur: holdOf(cues, passStart + IDLE_SECONDS),
        act: null,
        changes: changesFrom(cues, null),
        bootIn: Number.NEGATIVE_INFINITY,
        out: Number.POSITIVE_INFINITY,
      };
    }
    case "action":
    case "state": {
      const seg = segmentAt(animation, T);
      if (!seg) {
        const cues = [[0, "neutral"]] as const;
        return {
          cur: holdOf(cues, Number.POSITIVE_INFINITY),
          act: null,
          changes: changesFrom(cues, null),
          bootIn: Number.NEGATIVE_INFINITY,
          out: Number.POSITIVE_INFINITY,
        };
      }
      // Cues of every segment of this sequence, as absolute times within the current pass.
      const sequence = animation.id;
      const passStart =
        T -
        (((T % durationOfSequence(sequence)) + durationOfSequence(sequence)) %
          durationOfSequence(sequence));
      const cues: [number, string][] = [];
      for (const [actId] of segmentsOf(sequence)) {
        const act = ACTS[actId];
        if (!act) continue;
        for (const [at, face] of act.faces) cues.push([passStart + at, face]);
      }
      cues.sort((a, b) => a[0] - b[0]);
      const cur = holdOf(cues, passStart + durationOfSequence(sequence));
      const w = MOTION.enter(T / 0.3);
      return {
        cur,
        act: { name: seg.act, t: seg.localT, w },
        changes: changesFrom(cues, seg.act),
        bootIn: Number.NEGATIVE_INFINITY,
        out: Number.POSITIVE_INFINITY,
      };
    }
  }
};

const durationOfSequence = (id: string): number => SEQUENCES[id]?.duration ?? 3;
const segmentsOf = (id: string) => SEQUENCES[id]?.segments ?? [];

const EMPTY_LIMBS: Limbs = { l: [0, 0], r: [0, 0] };

/** The face with its eye holes moved by whole cells, kept inside rows 2–9 and cols 1–12. */
export const shiftHoles = (px: Px, dx: number, dy: number): Px => {
  const sx = Math.round(dx);
  const sy = Math.round(dy);
  if (!sx && !sy) return px;
  const out = px.slice();
  const holes: [number, number][] = [];
  for (let r = 2; r <= 9; r++) {
    for (let c = 1; c <= 12; c++) {
      if (!px[r * COLS + c]) {
        holes.push([r, c]);
        out[r * COLS + c] = 1;
      }
    }
  }
  for (const [r, c] of holes) {
    const nr = Math.min(9, Math.max(2, r + sy));
    const nc = Math.min(12, Math.max(1, c + sx));
    out[nr * COLS + nc] = 0;
  }
  return out;
};

export const renderBotFrame = (input: FrameInput): Frame => {
  const strict = input.mode === "terminal";
  const Traw = Math.max(0, input.t);
  const T = strict ? Math.floor(Traw * 12) / 12 : Traw;
  const F = Math.floor(T * 12);
  const timeline = timelineAt(input, T);
  const { act, changes, bootIn, out } = timeline;
  const still = input.still === true && !act;
  // A portrait has no history: the face is its own predecessor, so nothing flashes or eases in.
  const cur = still
    ? { ...timeline.cur, prevKey: timeline.cur.key, at: T }
    : timeline.cur;
  const reduced = input.reduced === true;
  const quiet = reduced || still;
  // The clock the hands, legs and tears read: a portrait sits at phase zero of every wave.
  const Tm = still ? 0 : T;

  let w = act ? act.w : 0;
  const at = act ? (strict ? Math.floor(act.t * 12) / 12 : act.t) : 0;
  const actDef = act ? ACTS[act.name] : undefined;
  let rig: Rig =
    act && actDef
      ? actDef.fn(at, w, input.mode)
      : exprRigFor(
          cur.key,
          still ? (PORTRAIT_FRAME[cur.key] ?? 0) / 12 : T - cur.at,
        );
  if (!act && rig.strict) w = 1;

  // Body offsets: whole cells in terminal mode; HD keeps sub-cell motion, rotation and squash.
  {
    let bx = still ? 0 : (rig.bx ?? 0) * (act ? w : 1);
    let by = still ? 0 : (rig.by ?? 0) * (act ? w : 1);
    const idle =
      !act && IDLE[cur.key] && !rig.strict && !quiet ? IDLE[cur.key] : null;
    if (idle) {
      if (strict) {
        const id = idle(Math.floor((T - cur.at) * 12));
        bx += id.bx ?? 0;
        by += id.by ?? 0;
      } else {
        const f0 = (T - cur.at) * 12;
        let ix = 0;
        let iy = 0;
        for (let j = 0; j < 4; j++) {
          const id = idle(Math.max(0, Math.floor(f0 - j)));
          ix += (id.bx ?? 0) / 4;
          iy += (id.by ?? 0) / 4;
        }
        bx += ix * 0.4;
        by += iy * 0.4;
      }
    }
    rig = strict
      ? { ...rig, bx: Math.round(bx), by: Math.round(by), rot: 0, sq: 0 }
      : {
          ...rig,
          bx,
          by,
          rot: (rig.rot ?? 0) * (act ? w : 1),
          sq: rig.sq ?? 0,
        };
  }

  const eyeKey =
    rig.eyes && w > 0.5 && cur.key === "reading" ? rig.eyes : cur.key;
  const facePx: Px = rig.facePx ?? FACES[eyeKey] ?? FACES.neutral ?? [];
  const prevPx: Px = rig.eyes ? facePx : (FACES[cur.prevKey] ?? facePx);
  const changed = cur.prevKey !== cur.key;
  let diffN = 0;
  for (let i = 0; i < COLS * 12; i++) if (!!facePx[i] !== !!prevPx[i]) diffN++;
  const since = T - cur.at;
  const flash = !quiet && changed && since < 0.17;

  // Scheduled blinks: first ~0.9 s into each hold, then every 2.4 s; every third hold opens with a double blink.
  let blinkRows = 0;
  if (!quiet && !neverBlinks(cur.key) && !rig.noBlink && T < out) {
    const holdLen = cur.end - cur.at;
    const first = 0.8 + (cur.i % 3) * 0.15;
    const check = (b: number) => {
      if (!(b + 0.45 < holdLen)) return;
      const u = since - b;
      if (u >= 0 && u < 0.2) blinkRows = u < 0.05 || u > 0.14 ? 2 : 3;
    };
    if (since >= first) {
      const k = Math.floor((since - first) / 2.4);
      check(first + 2.4 * k);
      if (k === 0 && cur.i % 3 === 0) check(first + 0.32);
    }
  }

  const cells: Cell[] = [];
  const glyphs: Glyph[] = [];
  let lowHole = 0;
  const holeCols = new Set<number>();
  for (let r = 2; r <= 9; r++)
    for (let c = 1; c <= 12; c++)
      if (!facePx[r * COLS + c]) {
        lowHole = r;
        holeCols.add(c);
      }
  const bodyFill = rig.bodyFill ?? "P";
  for (let r = 0; r < 12; r++) {
    const vin = T - (bootIn + r * 0.055);
    const vout = T - (out + (11 - r) * 0.05);
    if (vin < 0 || vout > 0) continue;
    for (let c = 0; c < COLS; c++) {
      if (isHand(r, c) || isLeg(r, c) || isEar(r, c)) continue;
      const i = r * COLS + c;
      const was = prevPx[i];
      const lid =
        blinkRows &&
        r >= 2 &&
        r <= 9 &&
        c >= 1 &&
        c <= 12 &&
        (blinkRows === 3 ? !(r === lowHole && holeCols.has(c)) : r < lowHole);
      const on = lid ? 1 : facePx[i];
      if (!on && !(flash && was)) continue;
      let fill: Cell["fill"] = bodyFill;
      let op = 1;
      const diff = !!facePx[i] !== !!was;
      const ring =
        !diffN &&
        r >= 3 &&
        r <= 8 &&
        c >= 1 &&
        c <= 12 &&
        on &&
        (
          [
            [0, 1],
            [0, -1],
            [1, 0],
            [-1, 0],
          ] as const
        ).some(([ox, oy]) => !facePx[(r + oy) * COLS + c + ox]);
      if (flash && (diff || ring)) {
        fill = "X";
        op = 1;
      } else if (!on) op = 0.28;
      if (vin < 0.08) fill = "X";
      cells.push(cel(c, r, fill, op === 1 ? undefined : op));
    }
  }

  // Tears on sad: whole-cell drops at 12 fps, with flicker, one-cell jumps and ghost slices.
  if (input.props && cur.key === "sad" && T < out) {
    for (const side of [0, 1] as const) {
      const u0 = since - 0.25 - side * 0.5;
      if (u0 < 0) continue;
      const u = (u0 % 1.2) / 1.2;
      const Fq = Math.floor(T * 12);
      const hsh = (n: number) => {
        const v = Math.sin(n * 12.9898 + side * 78.233) * 43758.5453;
        return v - Math.floor(v);
      };
      const h = hsh(Fq);
      const h2 = hsh(Fq * 1.7 + 3);
      if (h < 0.12) continue;
      const x0 = side ? 10 : 3;
      const y = 7 + Math.floor(u * 5.5);
      const dx = h > 0.86 ? (h2 > 0.5 ? 1 : -1) : 0;
      const x = x0 + dx;
      cells.push(cel(x, y, "X", y >= 11 ? 0.5 : undefined));
      if (y > 7) cells.push(cel(x, y - 1, "X", 0.4));
      if (h > 0.7 && h <= 0.86)
        cells.push({
          x: x + (h2 > 0.5 ? 1 : -1),
          y,
          w: CELL,
          h: 0.5,
          fill: "X",
          opacity: 0.6,
        });
    }
  }

  if (input.props) {
    if (rig.props) cells.push(...rig.props);
    if (rig.glyphs) glyphs.push(...rig.glyphs);
  } else if (rig.props) {
    // Small sizes hide accessories, not eyes: hearts, stars, shades and glasses stay on the face.
    cells.push(...rig.props.filter(inEyeRegion));
  }

  // Ears: whole cells, stepping one frame after the face (left) and two (right).
  const earIn = Number.isFinite(bootIn)
    ? F - Math.floor(bootIn * 12)
    : Number.POSITIVE_INFINITY;
  const earVis = earIn >= 0 && T - (out + 11 * 0.05) <= 0;
  if (earVis && !rig.noEars) {
    for (const side of [0, 1] as const) {
      const shape = earAt(changes, side, F);
      const fill = earIn < 1 ? "X" : "P";
      for (const [c, r] of EAR[shape].cells)
        cells.push(cel(side ? 13 - c : c, r, fill));
    }
  }

  // Hands and legs: the pose's offset, eased, mixed toward the act's.
  for (const side of ["l", "r"] as const) {
    const c = side === "l" ? 0 : 13;
    let [dx, dy] = handOffset(Tm, cur, side);
    if (rig.hands)
      [dx, dy] = mix2([dx, dy], (rig.hands ?? EMPTY_LIMBS)[side], w);
    if (strict) {
      dx = Math.round(dx);
      dy = Math.round(dy);
    }
    for (const r of [5, 6]) {
      if (!(T - (bootIn + r * 0.055) >= 0 && T - (out + (11 - r) * 0.05) <= 0))
        continue;
      cells.push(
        cel(c + dx, r + dy, T - (bootIn + r * 0.055) < 0.08 ? "X" : "P"),
      );
    }
  }
  const legVis = T - (bootIn + 11 * 0.055) >= 0 && T - out <= 0;
  if (legVis && !rig.noLegs) {
    for (const side of ["l", "r"] as const) {
      const cs = side === "l" ? [3, 4] : [9, 10];
      let [dx, dy] = legOffset(Tm, cur, side);
      if (rig.legs)
        [dx, dy] = mix2([dx, dy], (rig.legs ?? EMPTY_LIMBS)[side], w);
      if (strict) {
        dx = Math.round(dx);
        dy = Math.round(dy);
      }
      const fill = T - (bootIn + 11 * 0.055) < 0.08 ? "X" : "P";
      for (const cc of cs) cells.push(cel(cc + dx, 11 + dy, fill));
    }
  }

  // Z's while sleepy, drifting up and right.
  const sleepy = cur.key === "sleepy";
  if (input.props && sleepy && T < out) {
    for (const k of [0, 1, 2]) {
      if (strict) {
        const age = Math.floor((since - 0.6 - k * 0.8) * 12);
        if (age < 0 || age >= 24) continue;
        cells.push(
          ...spr(
            ["WWWW", "..W.", ".W..", "WWWW"],
            13 + (age >> 3),
            -1 - (age >> 2),
            () => (age > 18 ? "S" : "G"),
          ),
        );
      } else {
        const u = (since - 0.6 - k * 0.8) / 2.2;
        if (u < 0 || u > 1) continue;
        const x = 12.2 + u * 2.2 + Math.sin(u * 6) * 0.3;
        const y = -0.8 - u * 4;
        const sc = 0.32 + u * 0.18;
        const op = Math.min(1, u * 5, (1 - u) * 3);
        ["####", "..#.", ".#..", "####"].forEach((row, ry) => {
          row.split("").forEach((ch, rx) => {
            if (ch === "#")
              cells.push({
                x: x + rx * sc,
                y: y + ry * sc,
                w: sc * 1.04,
                h: sc * 1.04,
                fill: "G",
                opacity: op,
              });
          });
        });
      }
    }
  }

  const p = MOTION.pop(since / 0.32);
  const q = (rig.sq ?? 0) * w;
  const sx = strict ? 1 : (1 + 0.06 * (1 - p)) * (1 + 0.12 * q);
  const sy = strict ? 1 : (1 - 0.07 * (1 - p)) * (1 - 0.14 * q);
  const bob =
    strict || quiet
      ? 0
      : Math.sin((T * Math.PI * 2) / (sleepy ? 3.2 : 2.2)) *
        (sleepy ? 0.18 : 0.1);

  return {
    cells,
    glyphs,
    bx: rig.bx ?? 0,
    by: rig.by ?? 0,
    rot: rig.rot ?? 0,
    bob,
    sx,
    sy,
    face: cur.key,
    act: act ? act.name : null,
  };
};

const exprRigFor = (key: string, t: number): Rig => {
  if (key === "dizzy") return dizzyRig(t);
  if (key === "cool") return coolRig(t);
  return exprRig(key, t);
};

/** The bounding box of a frame's cells, in cells (for sizing a tile that must not clip props). */
export const frameBounds = (
  frame: Frame,
): { minX: number; minY: number; maxX: number; maxY: number } => {
  let minX = 0;
  let minY = 0;
  let maxX = COLS;
  let maxY = 12;
  for (const c of frame.cells) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  return { minX, minY, maxX, maxY };
};

export { clamp };
