export const THEME_STORAGE_KEY = "openbot-theme";

/**
 * The three things a person can ask for. `system` follows the operating system and is the default
 * for anybody who never chose: a fresh browser gets the appearance the rest of their screen has
 * rather than a light page in a dark desktop.
 */
export type ThemePreference = "light" | "dark" | "system";

/**
 * What the stored value means. The key predates `system`, when it held only `dark` or `light`, so
 * both still parse to what they always meant; anything else — absent, or a value a future build
 * writes — is `system`, which is the one answer that is never wrong for long.
 */
export function parseStoredTheme(value: string | null): ThemePreference {
  return value === "dark" || value === "light" ? value : "system";
}

/**
 * The appearance a preference resolves to right now. `systemDark` is the answer to
 * `matchMedia("(prefers-color-scheme: dark)")`, passed in so this stays a pure function the tests
 * and the pre-paint script in `index.html` can both agree with.
 */
export function resolveDark(theme: ThemePreference, systemDark: boolean) {
  return theme === "system" ? systemDark : theme === "dark";
}

/**
 * Kept for callers written against the boolean API: true only for a stored `dark`. A stored
 * `system` on a dark desktop is dark too, but this function cannot know that; prefer
 * `parseStoredTheme` + `resolveDark` where the operating system's answer is available.
 */
export function parseStoredDarkTheme(value: string | null) {
  return parseStoredTheme(value) === "dark";
}

type ThemeEffects = {
  setStoredValue: (key: string, value: string) => void;
  toggleRootClass: (name: string, force: boolean) => void;
  setRootColorScheme: (scheme: "dark" | "light") => void;
};

/**
 * Persists the preference and paints the resolved appearance. The stored value is the preference,
 * not the resolution: a person who chose `system` keeps following the system after a reload, which
 * is what makes `system` different from whichever of the two it happened to resolve to today.
 */
export function applyTheme(
  theme: ThemePreference,
  systemDark: boolean,
  effects: ThemeEffects,
) {
  const dark = resolveDark(theme, systemDark);
  effects.setStoredValue(THEME_STORAGE_KEY, theme);
  effects.toggleRootClass("dark", dark);
  // `index.html` sets this inline before paint, and an inline style outranks the palette.
  effects.setRootColorScheme(dark ? "dark" : "light");
}

/** The boolean form of `applyTheme`, for callers that still think in `dark` / `light`. */
export function applyDarkTheme(dark: boolean, effects: ThemeEffects) {
  applyTheme(dark ? "dark" : "light", dark, effects);
}
