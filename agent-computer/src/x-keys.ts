/**
 * From what a web browser calls a key to what an X server calls it.
 *
 * The surface sends the keys as the person's browser reports them: a DOM `key` ("a", "Enter", "α")
 * and a DOM `code` ("KeyA", "Enter", "KeyA"). The desktop takes X keysyms. A physical key is the
 * bridge: the X keymap on the virtual display is the US layout, so the keycode of the key the
 * person pressed, found by its `code`, produces the right character once the X server applies the
 * Shift the person is also holding — the surface forwards modifier keys as keys of their own.
 *
 * That holds while the person's layout agrees with the display's about what the key says. A person
 * typing on a Greek layout presses `KeyA` and means "α", and the US key would type "a". So a
 * printable key is mapped through its code only when the character it produced is one the US key
 * can produce; anything else is typed as text instead, which `xdotool type` handles by mapping the
 * character into a spare keycode for the moment it is needed.
 */

/** What the US key at each `code` types, unshifted and shifted. */
const US_KEYS: Record<string, readonly [string, string]> = {
  Backquote: ["`", "~"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Space: [" ", " "],
  IntlBackslash: ["<", ">"],
};
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  US_KEYS[`Key${letter.toUpperCase()}`] = [letter, letter.toUpperCase()];
}

/** The keysym name of each unshifted US key, where it is not the character itself. */
const KEYSYM_OF_CHARACTER: Record<string, string> = {
  "`": "grave",
  "-": "minus",
  "=": "equal",
  "[": "bracketleft",
  "]": "bracketright",
  "\\": "backslash",
  ";": "semicolon",
  "'": "apostrophe",
  ",": "comma",
  ".": "period",
  "/": "slash",
  " ": "space",
  "<": "less",
};

/** Keys that are not characters, by DOM `key`, with the two-sided ones decided by `code`. */
const NAMED_KEYS: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  CapsLock: "Caps_Lock",
  NumLock: "Num_Lock",
  ScrollLock: "Scroll_Lock",
  ContextMenu: "Menu",
  PrintScreen: "Print",
  Pause: "Pause",
  AltGraph: "ISO_Level3_Shift",
};
for (let n = 1; n <= 12; n++) NAMED_KEYS[`F${n}`] = `F${n}`;

const SIDED_KEYS: Record<string, string> = {
  Shift: "Shift",
  Control: "Control",
  Alt: "Alt",
  Meta: "Super",
};

const NUMPAD: Record<string, string> = {
  NumpadAdd: "KP_Add",
  NumpadSubtract: "KP_Subtract",
  NumpadMultiply: "KP_Multiply",
  NumpadDivide: "KP_Divide",
  NumpadDecimal: "KP_Decimal",
  NumpadEnter: "KP_Enter",
};
for (let n = 0; n <= 9; n++) NUMPAD[`Numpad${n}`] = `KP_${n}`;

export type XKey =
  /** Press this keysym's key. The X server applies whatever modifiers are held. */
  | { kind: "keysym"; keysym: string }
  /** No key on the display types this; type the character itself, once, on the way down. */
  | { kind: "text"; text: string }
  /** Nothing to send: a key the desktop has no use for. */
  | { kind: "none" };

/** What to send X for one key the person pressed. */
export function xKeyFor(message: { key: string; code: string }): XKey {
  const { key, code } = message;

  const sided = SIDED_KEYS[key];
  if (sided) {
    return {
      kind: "keysym",
      keysym: `${sided}_${code.endsWith("Right") ? "R" : "L"}`,
    };
  }
  const named = NAMED_KEYS[key];
  if (named) return { kind: "keysym", keysym: named };
  const numpad = NUMPAD[code];
  if (numpad) return { kind: "keysym", keysym: numpad };

  if (key.length === 1 || [...key].length === 1) {
    const usKey = US_KEYS[code];
    if (usKey && (usKey[0] === key || usKey[1] === key)) {
      const base = usKey[0];
      return { kind: "keysym", keysym: KEYSYM_OF_CHARACTER[base] ?? base };
    }
    // A character the US key under the finger does not type: a Greek letter, an accented one, an
    // emoji from a picker. Typed, rather than guessed at.
    return key.trim() === "" && key !== " "
      ? { kind: "none" }
      : { kind: "text", text: key };
  }

  // Dead keys, IME composition states, media keys: nothing on the desktop wants them.
  return { kind: "none" };
}

/** The X button a wheel turn presses, and how many times, from the browser's pixel delta. */
export function wheelClicks(
  deltaX: number,
  deltaY: number,
): Array<{ button: 4 | 5 | 6 | 7; times: number }> {
  const clicks: Array<{ button: 4 | 5 | 6 | 7; times: number }> = [];
  // One browser notch is about a hundred pixels; one X wheel click is one notch.
  const times = (delta: number) =>
    Math.max(1, Math.min(10, Math.round(Math.abs(delta) / 100)));
  if (deltaY !== 0)
    clicks.push({ button: deltaY > 0 ? 5 : 4, times: times(deltaY) });
  if (deltaX !== 0)
    clicks.push({ button: deltaX > 0 ? 7 : 6, times: times(deltaX) });
  return clicks;
}
