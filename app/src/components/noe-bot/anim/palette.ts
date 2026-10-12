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
