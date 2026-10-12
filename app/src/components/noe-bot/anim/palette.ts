/**
 * Colours for the character's inks.
 *
 * The design draws the body in rose on near-black with paper, line, key and dim props, and never
 * another colour. Inside an avatar the body is the scheme's ink on the scheme's background, so the
 * light props move to the line grey and the dark ones to key, where paper would vanish on a white
 * body and ink on a black one.
 */

import type { Ink } from "./sprites";

export type Palette = Record<Ink, string> & { background: string };

export const DESIGN_PALETTE: Palette = {
  P: "#ff2056",
  D: "#09090b",
  W: "#fafafa",
  G: "#a1a1aa",
  K: "#3f3f46",
  S: "#52525c",
  X: "#ffffff",
  background: "#09090b",
};

/** The character in an avatar's scheme: body in the ink, holes showing the background. */
export const avatarPalette = (scheme: {
  background: string;
  ink: string;
}): Palette => {
  const light = scheme.ink.toLowerCase() === "#ffffff";
  return {
    P: scheme.ink,
    D: scheme.background,
    W: light ? "#a1a1aa" : "#fafafa",
    G: light ? "#71717b" : "#a1a1aa",
    K: light ? "#3f3f46" : "#52525c",
    S: light ? "#52525c" : "#71717b",
    X: light ? "#a1a1aa" : "#ffffff",
    background: scheme.background,
  };
};

/** The face in whatever `currentColor` is, as an icon; props in greys; the glitch as the same colour. */
export const CURRENT_COLOR_PALETTE: Palette = {
  P: "currentColor",
  D: "transparent",
  W: "#a1a1aa",
  G: "#71717b",
  K: "#3f3f46",
  S: "#52525c",
  X: "currentColor",
  background: "transparent",
};

/**
 * A coloured Noë Bot standing on the page itself, with no disc behind it: every Bot's avatar, and
 * the chat's status row. The body is `currentColor` (the Bot's colour, set by the caller), the eye
 * holes show whatever is behind, and the props are greys that suit the page's theme through
 * `THEMED_INK_CLASS` on an ancestor — falling back to the icon greys where nothing sets them.
 */
export const THEMED_PALETTE: Palette = {
  P: "currentColor",
  D: "transparent",
  W: "var(--nb-paper, #a1a1aa)",
  G: "var(--nb-line, #71717b)",
  K: "var(--nb-key, #3f3f46)",
  S: "var(--nb-dim, #52525c)",
  X: "currentColor",
  background: "transparent",
};

/**
 * The page greys `THEMED_PALETTE` reads: on the light page paper turns dark and keys light, so a
 * book page or a pressed key still stands out; on the dark page they are the design's own inks.
 * Whole class names, because Tailwind only generates what it finds spelled in full.
 */
export const THEMED_INK_CLASS =
  "[--nb-paper:#52525c] [--nb-line:#a1a1aa] [--nb-key:#d4d4d8] [--nb-dim:#a1a1aa] dark:[--nb-paper:#fafafa] dark:[--nb-line:#a1a1aa] dark:[--nb-key:#3f3f46] dark:[--nb-dim:#52525c]";
