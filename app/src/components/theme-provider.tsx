import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  applyTheme,
  parseStoredTheme,
  resolveDark,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

type ThemeContextValue = {
  /** What this person asked for; `system` means the operating system decides. */
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  /** What is painted right now, after `system` has been resolved. */
  dark: boolean;
  /** The boolean form: an explicit light or dark choice. */
  setDark: (dark: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readSystemDark() {
  // `matchMedia` is missing in some test documents; no system answer means light.
  return typeof window.matchMedia === "function"
    ? window.matchMedia(SYSTEM_DARK_QUERY).matches
    : false;
}

function readStoredTheme() {
  // localStorage throws in some privacy modes; a theme is not worth taking the app down for.
  try {
    return parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(readStoredTheme);
  const [systemDark, setSystemDark] = useState(readSystemDark);

  /*
   * Follow the operating system while it is the one deciding. The listener is kept regardless of
   * the preference so switching to `system` later paints at once from the current answer rather
   * than from whatever was true at mount.
   */
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(SYSTEM_DARK_QUERY);
    const handleChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    applyTheme(theme, systemDark, {
      setStoredValue: (key, value) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // Same privacy modes as above: the page is still painted, the choice is just not kept.
        }
      },
      toggleRootClass: (name, force) =>
        document.documentElement.classList.toggle(name, force),
      setRootColorScheme: (scheme) => {
        document.documentElement.style.colorScheme = scheme;
      },
    });
  }, [theme, systemDark]);

  const setDark = useCallback(
    (dark: boolean) => setTheme(dark ? "dark" : "light"),
    [],
  );
  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      dark: resolveDark(theme, systemDark),
      setDark,
    }),
    [theme, systemDark, setDark],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return value;
}
