/**
 * The motion helpers the design's film uses, ported exactly.
 *
 * `noe-bot-film.jsx` leans on four helpers from the showcase engine (`Easing.easeOutCubic`,
 * `Easing.easeOutBack`, `Easing.easeInOutSine`, `clamp`) and defines the rest itself. Everything
 * here is a pure function of numbers, so the whole animation stays a pure function of time.
 */

export const easeOutCubic = (t: number): number => (t - 1) ** 3 + 1;

export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

export const easeInOutSine = (t: number): number =>
  -(Math.cos(Math.PI * t) - 1) / 2;

export const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));

/** The film's three motion curves: enter, pop (overshoots) and drift. */
export const MOTION = {
  enter: (t: number) => easeOutCubic(clamp(t, 0, 1)),
  pop: (t: number) => easeOutBack(clamp(t, 0, 1)),
  drift: (t: number) => easeInOutSine(clamp(t, 0, 1)),
} as const;

export type Vec = readonly [number, number];

export const mix = (a: number, b: number, k: number): number => a + (b - a) * k;
export const mix2 = (a: Vec, b: Vec, k: number): [number, number] => [
  mix(a[0], b[0], k),
  mix(a[1], b[1], k),
];

/** A piecewise path through `[time, value]` points, eased with `drift` between them. */
export const path = (t: number, pts: readonly Vec[]): number => {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return 0;
  if (t <= first[0]) return first[1];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) break;
    if (t <= b[0])
      return mix(a[1], b[1], MOTION.drift((t - a[0]) / (b[0] - a[0])));
  }
  return last[1];
};

/** The path's velocity, by central difference over 40 ms. */
export const vel = (t: number, pts: readonly Vec[]): number =>
  (path(t + 0.02, pts) - path(t - 0.02, pts)) / 0.04;

/** Whole-frame linear interpolation through `[frame, value]` points, rounded to a cell. */
export const lerpF = (F: number, pts: readonly Vec[]): number => {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return 0;
  if (F <= first[0]) return first[1];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) break;
    if (F <= b[0])
      return Math.round(a[1] + ((b[1] - a[1]) * (F - a[0])) / (b[0] - a[0]));
  }
  return last[1];
};

/** The film's deterministic hash: the same frame always scatters the same way. */
export const hh = (n: number): number => {
  const v = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
  return v - Math.floor(v);
};

/** A triangle wave of period 2 over `u`. */
export const tri = (u: number): number => 1 - Math.abs((((u % 2) + 2) % 2) - 1);

/** A sprite pattern rotated a quarter turn clockwise. */
export const rot90 = (p: readonly string[]): string[] => {
  const first = p[0] ?? "";
  return first.split("").map((_, i) =>
    p
      .map((r) => r[i] ?? ".")
      .reverse()
      .join(""),
  );
};

export type Jump = {
  by: number;
  sq: number;
  rot: number;
  air: number;
  crouch: number;
};

/** One jump of height `h` (grid units) with `spin` degrees, over `u` in 0..1.15; null outside. */
export const jumpAt = (u: number, h: number, spin: number): Jump | null => {
  if (u < 0 || u > 1.15) return null;
  if (u < 0.2) {
    const k = MOTION.drift(u / 0.2);
    return { by: 0.4 * k, sq: k, rot: 0, air: 0, crouch: k };
  }
  if (u < 0.85) {
    const a = (u - 0.2) / 0.65;
    return {
      by: -h * 4 * a * (1 - a),
      sq: -0.7 * Math.max(0, 1 - a * 3),
      rot: spin * MOTION.drift(a),
      air: clamp(Math.min(a, 1 - a) * 5, 0, 1),
      crouch: 0,
    };
  }
  const k = (u - 0.85) / 0.3;
  const b = Math.sin(Math.PI * k) * (1 - k);
  return { by: 0.5 * b, sq: 1.3 * b, rot: 0, air: 0, crouch: b };
};
