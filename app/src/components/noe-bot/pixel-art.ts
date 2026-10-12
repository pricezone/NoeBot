import {
  AVATAR_COLORS,
  type AvatarColor,
  type AvatarExpression,
  type AvatarScheme,
  avatarSchemeOf,
  isAvatarExpression,
  SEED_EXPRESSIONS,
} from "../../../../shared/avatar";
import { renderBotFrame } from "./anim/bot-frame";
import { COLS, type Px } from "./anim/pixels";
import { GRID_16, type HalfBlockDrawing } from "./drawings";

/**
 * From the brand guide's half-block drawings to something a screen can draw.
 *
 * Pure. The drawings in `drawings.ts` are the guide's text files verbatim; this decodes them into
 * pixels and the pixels into one SVG path, and picks a face for a Bot from its avatar seed. Nothing
 * here knows about React, which is what lets the data be checked in a test without a DOM.
 */

/**
 * One of the guide's eye-only expressions.
 *
 * The shared list's type, so the names the server accepts and the names drawn here are one type:
 * `facePath` indexes the drawings with it, which fails to compile if a drawing is missing, and a
 * test holds the drawings to the list in the other direction.
 */
export type Expression = AvatarExpression;

/** What can be on the face: the mascot's own capsule eyes, an expression, or offline. */
export type Face = Expression | "body" | "offline";

/** The faces a seed picks from, in the order it has always picked them; see `SEED_EXPRESSIONS`. */
export const EXPRESSIONS: readonly Expression[] = SEED_EXPRESSIONS;

export type PixelGrid = {
  width: number;
  height: number;
  /** `rows[y][x]`, true where the drawing has ink. */
  rows: boolean[][];
};

/**
 * Half-block characters to pixels.
 *
 * Each character is two pixels, one above the other: `█` lights both, `▀` the upper, `▄` the lower,
 * and a space neither. A row of characters is therefore two rows of pixels. Rows are padded to the
 * widest, so a drawing whose last row ends early still decodes to a rectangle.
 */
export function decodeHalfBlocks(drawing: HalfBlockDrawing): PixelGrid {
  const width = Math.max(...drawing.map((row) => [...row].length));
  const rows: boolean[][] = [];
  for (const line of drawing) {
    const upper: boolean[] = [];
    const lower: boolean[] = [];
    for (const glyph of [...line.padEnd(width, " ")]) {
      upper.push(glyph === "█" || glyph === "▀");
      lower.push(glyph === "█" || glyph === "▄");
    }
    rows.push(upper, lower);
  }
  return { width, height: rows.length, rows };
}

/**
 * Pixels to one SVG path, one rectangle per horizontal run.
 *
 * Runs rather than single pixels because a face is up to 168 rectangles, and the path is drawn for
 * every avatar in a roster. Each run is `M x y h w v 1 h -w z`, which closes cleanly and
 * needs no stroke; with `shape-rendering: crispEdges` adjacent runs meet without a seam.
 */
export function pathFor(grid: PixelGrid): string {
  const parts: string[] = [];
  grid.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return parts.join("");
}

export type FacePath = { width: number; height: number; path: string };

const cache = new Map<Face, FacePath>();

/** The design's 168-cell array as rows, the shape the path builder reads. */
export function gridFromPx(px: Px): PixelGrid {
  const rows: boolean[][] = [];
  for (let y = 0; y < px.length / COLS; y++) {
    rows.push(Array.from({ length: COLS }, (_, x) => !!px[y * COLS + x]));
  }
  return { width: COLS, height: rows.length, rows };
}

/**
 * The still drawing for a face, decoded once and kept.
 *
 * The mascot's own eyes come from the guide's half-block body. Every expression is its portrait
 * (`renderBotFrame` with `still`): the face settled and centred, with the props that are its eyes
 * cut out of the ink — heart eyes, star eyes, shades, glasses — so a 16 px icon reads the same
 * face the animation does rather than a solid block. Offline wears the unplugged state's face, the
 * sad one.
 */
export function facePath(face: Face): FacePath {
  const known = cache.get(face);
  if (known) return known;
  const pixels =
    face === "body"
      ? decodeHalfBlocks(GRID_16.body)
      : gridFromPortrait(face === "offline" ? "sad" : face);
  const result = {
    width: pixels.width,
    height: pixels.height,
    path: pathFor(pixels),
  };
  cache.set(face, result);
  return result;
}

/** A face's portrait as a 14 × 12 grid: body ink, with any eye-region prop as a cut-out. */
export function gridFromPortrait(face: string): PixelGrid {
  const frame = renderBotFrame({
    animation: { kind: "face", id: face },
    t: 0,
    mode: "terminal",
    props: false,
    still: true,
  });
  const rows: boolean[][] = Array.from({ length: 12 }, () =>
    Array.from({ length: COLS }, () => false),
  );
  const inside = (x: number, y: number) =>
    x >= 0 && x < COLS && y >= 0 && y < 12;
  for (const cell of frame.cells) {
    const x = Math.round(cell.x);
    const y = Math.round(cell.y);
    if (!inside(x, y)) continue;
    const row = rows[y];
    if (!row) continue;
    if (cell.fill === "P") row[x] = true;
  }
  for (const cell of frame.cells) {
    const x = Math.round(cell.x);
    const y = Math.round(cell.y);
    if (!inside(x, y) || cell.fill === "P") continue;
    const row = rows[y];
    if (row) row[x] = false;
  }
  return { width: COLS, height: 12, rows };
}

/** FNV-1a, 32 bit. Small, stable across runtimes, and spreads short seeds well enough. */
function hash(text: string, salt: number): number {
  let value = 0x811c9dc5 ^ salt;
  for (const char of text) {
    value ^= char.codePointAt(0) ?? 0;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/**
 * Which expression a Bot wears.
 *
 * Chosen from the avatar seed, which the tenant package sets per coworker and which otherwise is
 * the Bot's id, so the same Bot has the same face in every roster, card and transcript, and two
 * Bots usually differ. Never "body" or "offline": the mascot's own eyes belong to the product, not
 * to any one coworker, and offline is a state rather than a personality.
 */
export function expressionFor(seed: string): Expression {
  const index = hash(seed, 0) % EXPRESSIONS.length;
  return EXPRESSIONS[index] ?? "neutral";
}

export type { AvatarScheme };

/**
 * The guide's approved backgrounds, each with the ink it allows on it: the ones a seed picks from.
 *
 * Rose takes white artwork only; the near-black of the wordmark takes white; the light grey takes
 * black. Three, so a roster is not a wall of one colour, and no colour the guide does not list. A
 * person choosing has the whole of `AVATAR_COLORS`; a Bot nobody chose for keeps to these.
 */
export const AVATAR_SCHEMES: readonly AvatarScheme[] = AVATAR_COLORS.filter(
  (scheme) => scheme.brand,
);

/** Salted differently from the expression, so the two choices are not locked to each other. */
export function schemeFor(seed: string): AvatarScheme {
  const index = hash(seed, 0x9e3779b9) % AVATAR_SCHEMES.length;
  return AVATAR_SCHEMES[index] ?? AVATAR_COLORS[0];
}

/** What a profile carries about its avatar: the seed, and whatever a person chose. */
export type AvatarChoice = {
  seed: string;
  color?: AvatarColor | null;
  expression?: AvatarExpression | null;
};

/**
 * What a Bot's avatar wears: the colour and the expression a person chose, each where one was
 * chosen, and the seed's pick for whichever half was not.
 *
 * Every surface that draws a Bot asks this rather than `schemeFor` and `expressionFor` directly, so
 * a choice shows the same everywhere — on the avatar, and as the colour of the person's own bubbles
 * in a conversation with that Bot. A value outside the palette is ignored rather than drawn, which
 * the type already rules out and a stale cache entry could still deliver.
 */
export function avatarLook({ seed, color, expression }: AvatarChoice): {
  scheme: AvatarScheme;
  expression: Expression;
} {
  return {
    scheme: avatarSchemeOf(color) ?? schemeFor(seed),
    expression: isAvatarExpression(expression)
      ? expression
      : expressionFor(seed),
  };
}

/** WCAG relative luminance of a `#rrggbb` colour, 0 for black to 1 for white. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * Which theme's page this background nearly disappears into, if either.
 *
 * The palette is the same in both themes, so the light grey sits on the light theme's white, and
 * the near-black on the dark theme's black, with almost nothing between them. Those get a hairline
 * in that theme only (`hairlineClassName`); every other colour is drawn as it is. Judged from the
 * colour's luminance rather than by name, so a colour added to the palette later is judged too.
 */
export function edgeFor(background: string): "light" | "dark" | null {
  const luminance = relativeLuminance(background);
  if (luminance > 0.8) return "light";
  if (luminance < 0.03) return "dark";
  return null;
}
