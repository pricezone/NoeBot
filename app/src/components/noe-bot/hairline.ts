import { edgeFor } from "./pixel-art";

/**
 * The hairline that keeps a Bot's colour visible on a page of almost the same colour.
 *
 * An avatar, or the person's bubble drawn in that avatar's colour, is the same colour in both
 * themes; the light grey on the light theme's white and the near-black on the dark theme's black
 * are each nearly invisible without an edge. `edgeFor` says which theme, if either, and this is the
 * edge: a ring for a round avatar, the border a bubble already reserves for a bubble. Every other
 * colour gets nothing, so a rose or a blue avatar is never outlined.
 *
 * Inset, for the ring, so the avatar stays the size it was asked to be: a stacked group of faces is
 * laid out to the pixel, and an outer ring would widen each one.
 *
 * Whole class names, written out, because Tailwind only generates what it can find spelled in full.
 */
const HAIRLINE = {
  ring: {
    light: "ring-1 ring-inset ring-black/10 dark:ring-0",
    dark: "dark:ring-1 dark:ring-inset dark:ring-white/15",
  },
  border: {
    light: "border-black/10 dark:border-transparent",
    dark: "dark:border-white/15",
  },
} as const;

export function hairlineClassName(
  background: string,
  as: "ring" | "border",
): string | undefined {
  const edge = edgeFor(background);
  return edge ? HAIRLINE[as][edge] : undefined;
}
