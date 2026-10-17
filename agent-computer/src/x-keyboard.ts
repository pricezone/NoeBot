import type { InputMessage } from "./screencast";
import type { XInput } from "./x-input";
import { xKeyFor } from "./x-keys";

/**
 * A person's keyboard on the desktop, and what it holds down there.
 *
 * A key reaches the display as a press and, later, a release, and the display holds the key down in
 * between. The person's own keyboard and the display's were let drift apart, which is why holding
 * Shift typed small letters and Command+V did not paste:
 *
 * A PRESS OR A RELEASE MISSED. A Shift pressed before the screen had the focus never reached the
 * display, and a Command released over another window stayed down on it. Every key the surface
 * sends says which modifiers the person holds (CDP's bitmask), so before a key that is not itself a
 * modifier the display is put in step: Shift, Control, Alt and Super pressed where the person holds
 * them and the display does not, let go of where the display holds them and the person does not.
 *
 * TEXT TYPED THROUGH HELD MODIFIERS. `xdotool type` types into whatever is held: text arriving while
 * Control was down (Command, on a Mac, is sent as Control) came out as shortcuts, "word" as
 * Control+W. It also lets go of Shift after a capital it typed, so the Shift the person was still
 * holding was gone for the keys after it. Text is typed with every modifier let go of first, and
 * the person's pressed again after.
 *
 * A PASTE IS A PASTE. Text the person pasted goes on the desktop's clipboard and is pasted with
 * Control+V, as they did it: instant at any length, every character intact (the US keymap has no
 * Greek), and the page's own paste handling runs. In a terminal, which reads Control+V as a control
 * character, it is Control+Shift+V. With no clipboard (no xclip) it is typed instead.
 *
 * NOTHING LEFT DOWN. `releaseAll` lets go of everything this keyboard pressed: the cast calls it
 * when the person's window loses the focus, when they hand the wheel back and when the screen stops,
 * so the Bot never types on a display with the person's Control still held.
 */

type KeyMessage = Extract<InputMessage, { type: "key" }>;
type TextMessage = Extract<InputMessage, { type: "text" }>;

/** The modifiers of CDP's bitmask, each with the keys on the display that hold it. */
const MODIFIERS = [
  { bit: 8, keysyms: ["Shift_L", "Shift_R"] },
  { bit: 2, keysyms: ["Control_L", "Control_R"] },
  { bit: 1, keysyms: ["Alt_L", "Alt_R"] },
  { bit: 4, keysyms: ["Super_L", "Super_R"] },
] as const;

type Modifier = (typeof MODIFIERS)[number];

function modifierOf(keysym: string): Modifier | undefined {
  return MODIFIERS.find((modifier) =>
    (modifier.keysyms as readonly string[]).includes(keysym),
  );
}

export type DesktopKeyboard = {
  key(x: XInput, message: KeyMessage): Promise<void>;
  text(x: XInput, message: TextMessage): Promise<void>;
  /** Let go of every key this keyboard pressed on the display. */
  releaseAll(x: XInput): Promise<void>;
  /** The keys held down on the display, in the order they were pressed. */
  held(): string[];
};

/** Terminal windows by their class: xfce4-terminal on this desktop, and the usual others. */
const TERMINAL_CLASS =
  /terminal|xterm|urxvt|rxvt|konsole|tilix|alacritty|kitty|terminator|wezterm/i;

export function isTerminal(windowClass: string | null): boolean {
  return windowClass !== null && TERMINAL_CLASS.test(windowClass);
}

/** One per live screen: what its person holds on the display. */
export function createDesktopKeyboard(): DesktopKeyboard {
  /** Pressed on the display and not let go of since, in the order pressed. */
  const held = new Set<string>();

  const press = async (x: XInput, keysym: string) => {
    await x.key(keysym, true);
    held.add(keysym);
  };
  const release = async (x: XInput, keysym: string) => {
    held.delete(keysym);
    await x.key(keysym, false);
  };

  /** The display's modifiers put in step with the ones the person holds. */
  const reconcile = async (x: XInput, bits: number) => {
    for (const modifier of MODIFIERS) {
      const down = modifier.keysyms.filter((keysym) => held.has(keysym));
      if (bits & modifier.bit) {
        if (down.length === 0) await press(x, modifier.keysyms[0]);
      } else {
        for (const keysym of down) await release(x, keysym);
      }
    }
  };

  /** `work` done with no modifier down, and the person's modifiers pressed again after it. */
  const withoutModifiers = async (x: XInput, work: () => Promise<void>) => {
    const modifiers = [...held].filter((keysym) => modifierOf(keysym));
    for (const keysym of [...modifiers].reverse()) await release(x, keysym);
    try {
      await work();
    } finally {
      for (const keysym of modifiers) await press(x, keysym);
    }
  };

  return {
    async key(x, message) {
      const bits = Number.isInteger(message.modifiers)
        ? (message.modifiers as number)
        : undefined;
      const key = xKeyFor(message);
      if (key.kind === "keysym") {
        const modifier = modifierOf(key.keysym);
        if (message.event === "down") {
          if (!modifier && bits !== undefined) await reconcile(x, bits);
          await press(x, key.keysym);
          return;
        }
        await release(x, key.keysym);
        // A modifier the person no longer holds is let go of on both sides, the side pressed in
        // step for it included: releasing the right Shift must not leave the left one down.
        if (modifier && bits !== undefined && !(bits & modifier.bit))
          for (const keysym of modifier.keysyms)
            if (held.has(keysym)) await release(x, keysym);
        return;
      }
      if (key.kind === "text" && message.event === "down")
        await withoutModifiers(x, () => x.type(key.text));
    },

    async text(x, message) {
      await withoutModifiers(x, async () => {
        const pasting = message.paste === true && x.setClipboard !== undefined;
        // Asked alongside the copy rather than after it, so a paste waits for neither twice.
        const [copied, windowClass] = pasting
          ? await Promise.all([
              x.setClipboard?.(message.text).catch(() => false) ?? false,
              x.activeWindowClass?.().catch(() => null) ?? null,
            ])
          : [false, null];
        if (!copied) {
          await (message.paste
            ? x.type(message.text, { clearModifiers: true })
            : x.type(message.text));
          return;
        }
        // A terminal takes Control+V as a control character and pastes on Control+Shift+V.
        const shortcut = isTerminal(windowClass)
          ? ["Control_L", "Shift_L"]
          : ["Control_L"];
        const pressed: string[] = [];
        try {
          for (const keysym of shortcut) {
            await x.key(keysym, true);
            pressed.push(keysym);
          }
          await x.key("v", true);
          await x.key("v", false);
        } finally {
          for (const keysym of pressed.reverse()) await x.key(keysym, false);
        }
      });
    },

    async releaseAll(x) {
      // Last pressed, first let go: the letter before the Control it was pressed under.
      const keys = [...held].reverse();
      held.clear();
      let failure: unknown;
      for (const keysym of keys) {
        try {
          await x.key(keysym, false);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    },

    held: () => [...held],
  };
}
