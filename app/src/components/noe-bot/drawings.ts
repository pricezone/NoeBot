/**
 * Noë Bot, as the brand guide draws it for terminals.
 *
 * HyperNoesis Identity v8, "Terminal / CLI version": the mascot redrawn on a 16-pixel grid and set
 * in half-block glyphs, so each character carries two pixels, one above the other. `█` is both,
 * `▀` the upper, `▄` the lower, a space neither. The grid is 14 characters by 6 rows, so 14 by 12
 * pixels: the body, and a set of expressions that change only the eyes, the way the vector
 * mascot's state system does.
 *
 * ONLY THE 16 GRID. The guide also draws a 24 grid for banners; the app does not use it, at any
 * size, so that Noë Bot is one drawing everywhere it appears.
 *
 * The expressions are the brand sheet's eighteen (00 original … 17 injured), by the sheet's own
 * numbers and names, from the design's animation film (`anim/pixels.ts`). The guide's rule that
 * the mascot is never redrawn or given a face by hand is kept by keeping the data verbatim and
 * the decoder dumb. The 35 newer faces are hole grids rather than half-block rows and live with
 * the rest of the animation data.
 */

import { FACE_ROWS } from "./anim/pixels";

export type HalfBlockDrawing = readonly string[];

/** The 16 grid: 14 characters by 6 rows. The body with the capsule eyes is the mascot itself. */
export const GRID_16 = {
  body: [
    "  ▄██▄▄▄▄██▄  ",
    " ████████████ ",
    "▄███▀ ██ ▀███▄",
    "▀███▄ ██ ▄███▀",
    " ████████████ ",
    "  ▀██▀▀▀▀██▀  ",
  ],
  expressions: {
    original: FACE_ROWS.original,
    neutral: FACE_ROWS.neutral,
    attentive: FACE_ROWS.attentive,
    surprised: FACE_ROWS.surprised,
    excited: FACE_ROWS.excited,
    happy: FACE_ROWS.happy,
    laughing: FACE_ROWS.laughing,
    angry: FACE_ROWS.angry,
    sad: FACE_ROWS.sad,
    scared: FACE_ROWS.scared,
    suspicious: FACE_ROWS.suspicious,
    confused: FACE_ROWS.confused,
    curious: FACE_ROWS.curious,
    proud: FACE_ROWS.proud,
    shy: FACE_ROWS.shy,
    unimpressed: FACE_ROWS.unimpressed,
    sleepy: FACE_ROWS.sleepy,
    injured: FACE_ROWS.injured,
  },
} as const;
