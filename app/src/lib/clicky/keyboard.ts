import { useEffect, useRef } from "react";
import { keyOf } from "@/lib/hotkeys/hotkeys";

/**
 * Clicky's one keyboard shortcut: Control, Option (Alt) and S stops it, on every platform.
 *
 * Control rather than Command on a Mac on purpose: Command+Option+S belongs to browsers and other
 * apps, and an emergency stop must never be taken first by something else. The S is read the way
 * every shortcut here is (`keyOf`): Option+S writes "ß" on a Mac and Ctrl+Alt+S may write a letter
 * of another script, and the physical key is still S.
 *
 * AltGr is not Control and Alt, even though Windows reports it as both: on a Polish keyboard AltGr
 * and S writes "ś", and typing a word must never stop anything. The browser says which it was with
 * the AltGraph modifier. Not on a Mac, which has no AltGr, and where a browser may report Option as
 * AltGraph: there Control, Option and S is always the shortcut.
 *
 * Not in `HOTKEYS`: that registry spells `mod` as Command on a Mac and has no way to say Control.
 */
export function isClickyStopShortcut(event: KeyboardEvent): boolean {
  const altGraph = !onMac() && event.getModifierState?.("AltGraph") === true;
  return (
    event.ctrlKey &&
    event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !altGraph &&
    keyOf(event) === "s"
  );
}

function onMac(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

/** The shortcut as keycaps, the way this keyboard writes them, for the places that teach it. */
export function clickyStopKeys(): readonly string[] {
  return onMac() ? ["⌃", "⌥", "S"] : ["Ctrl", "Alt", "S"];
}

/** The same, for `aria-keyshortcuts`. */
export const CLICKY_STOP_ARIA = "Control+Alt+S";

/**
 * Calls `onStop` when the Stop shortcut is pressed anywhere in the page, while `enabled`.
 *
 * On the window, after everything else: the live screen catches it first while the person is
 * driving (so it never reaches the Bot's computer as a keystroke) and stops Clicky itself.
 */
export function useClickyStopShortcut(
  onStop: () => void,
  enabled: boolean,
): void {
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !isClickyStopShortcut(event)) return;
      event.preventDefault();
      stopRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
