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
 * Transcribed from the guide's `terminal/noe-bot-16.txt` and `noe-bot-16-{name}.txt`, verbatim,
 * as the data below. The drawing is decoded into pixels at run time and drawn as SVG
 * rectangles, which is the only way the 16 grid survives a 16-pixel slot: as text it would need a
 * three-pixel font. The guide's rule that the mascot is never redrawn or given a face by hand is
 * kept by keeping the data verbatim and the decoder dumb.
 */

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
  offline: [
    "  ▄██▄▄▄▄██▄  ",
    " ████████████ ",
    "▄███▀▀██▀▀███▄",
    "▀████████████▀",
    " ████████████ ",
    "  ▀██▀▀▀▀██▀  ",
  ],
  expressions: {
    neutral: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄████▀██▀████▄",
      "▀████▄██▄████▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    attentive: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄██▀▀████▀▀██▄",
      "▀██▄▄████▄▄██▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    surprised: [
      "  ▄██▄▄▄▄██▄  ",
      " ████▀██▀████ ",
      "▄███  ██  ███▄",
      "▀███  ██  ███▀",
      " ████▄██▄████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    excited: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄██▀▄▀██▀▄▀██▄",
      "▀██▄█▄██▄█▄██▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    happy: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄███▀████▀███▄",
      "▀██▄█▄██▄█▄██▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    laughing: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄██▄ ▀██▀ ▄██▄",
      "▀████▄██▄████▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    angry: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄███ ▄██▄ ███▄",
      "▀██▄██████▄██▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    sad: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄████████████▄",
      "▀███▀████▀███▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    scared: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄██▀▀████▀▀██▄",
      "▀████▄██▄████▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    suspicious: [
      "  ▄██▄▄▄▄██▄  ",
      " ███▀████████ ",
      "▄███▄▀███████▄",
      "▀████▄██▀▀███▀",
      " █████████▄██ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    confused: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████▀▀██ ",
      "▄███▀▄███▄▄██▄",
      "▀████████████▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    curious: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄██▄▀▄██▄▀▄██▄",
      "▀████████████▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    proud: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄████████████▄",
      "▀██▀▄████▄▀██▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    shy: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄██▀▀▀██▀▀▀██▄",
      "▀████████████▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
    unimpressed: [
      "  ▄██▄▄▄▄██▄  ",
      " ████████████ ",
      "▄████████████▄",
      "▀██▄▀▄██▄▀▄██▀",
      " ████████████ ",
      "  ▀██▀▀▀▀██▀  ",
    ],
  },
} as const;
