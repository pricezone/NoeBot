/**
 * What a person may choose for a Bot's avatar: one of these colours and one of these expressions.
 *
 * Shared because two sides have to agree on it. The server refuses a `PATCH /api/agents/:id` that
 * names anything else, and the app draws the swatches and the faces from the same lists, so a
 * colour offered on screen is always one the server will store and a stored one is always one the
 * app can draw. Nothing here knows about React or the database.
 *
 * THE SAME COLOURS IN BOTH THEMES. A Bot's colour is part of who it is, like its name, so it does
 * not change when somebody switches to dark mode; only the page behind it does. Where a colour
 * nearly vanishes into one theme's page, the app adds a hairline around it rather than changing it.
 */

/**
 * Each background with the ink the face is drawn in on it.
 *
 * The first three are the brand guide's own: rose takes white artwork only, the wordmark's
 * near-black takes white, the light grey takes black. A Bot with no colour chosen gets one of
 * those three from its avatar seed, exactly as before there was a choice, so existing Bots keep the
 * face they had. The rest are offered only to a person choosing, each with whichever of white or
 * black reads on it.
 */
export const AVATAR_COLORS = [
  { background: "#ff2056", ink: "#ffffff", label: "Rose", brand: true },
  { background: "#18181b", ink: "#ffffff", label: "Black", brand: true },
  { background: "#f4f4f5", ink: "#09090b", label: "Light gray", brand: true },
  { background: "#2563eb", ink: "#ffffff", label: "Blue", brand: false },
  { background: "#16a34a", ink: "#ffffff", label: "Green", brand: false },
  { background: "#7c3aed", ink: "#ffffff", label: "Violet", brand: false },
  { background: "#0d9488", ink: "#ffffff", label: "Teal", brand: false },
  { background: "#f59e0b", ink: "#09090b", label: "Amber", brand: false },
] as const;

export type AvatarScheme = (typeof AVATAR_COLORS)[number];

/** A colour as it is stored and sent: the background's hex, lower case. */
export type AvatarColor = AvatarScheme["background"];

/**
 * The brand guide's eye-only expressions, in the guide's order.
 *
 * The order is load-bearing: a Bot with no expression chosen wears the one its seed hashes to by
 * index, so reordering this list would change the face of every such Bot. The app's drawings are
 * keyed by exactly these names, and a test holds the two to each other.
 */
export const AVATAR_EXPRESSIONS = [
  "neutral",
  "attentive",
  "surprised",
  "excited",
  "happy",
  "laughing",
  "angry",
  "sad",
  "scared",
  "suspicious",
  "confused",
  "curious",
  "proud",
  "shy",
  "unimpressed",
] as const;

export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

export function isAvatarColor(value: unknown): value is AvatarColor {
  return AVATAR_COLORS.some((scheme) => scheme.background === value);
}

export function isAvatarExpression(value: unknown): value is AvatarExpression {
  return (AVATAR_EXPRESSIONS as readonly unknown[]).includes(value);
}

/** The scheme a stored colour names, or undefined for anything that is not one of the palette's. */
export function avatarSchemeOf(color: unknown): AvatarScheme | undefined {
  return AVATAR_COLORS.find((scheme) => scheme.background === color);
}
