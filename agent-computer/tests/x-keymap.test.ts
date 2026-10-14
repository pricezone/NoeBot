import { describe, expect, test } from "bun:test";
import { xdotoolEnvironment } from "../src/x-input";
import {
  emptyKeycodes,
  keysymOfCharacter,
  runsOf,
  spareKeycodes,
} from "../src/x-keymap";

describe("typing what the US keymap does not have", () => {
  test("a character's keysym: Latin-1 as itself, the rest in X's Unicode range", () => {
    expect(keysymOfCharacter("a")).toBe(0x61);
    expect(keysymOfCharacter("é")).toBe(0xe9);
    expect(keysymOfCharacter("α")).toBe(0x010003b1);
    expect(keysymOfCharacter("ή")).toBe(0x010003ae);
    expect(keysymOfCharacter("Ω")).toBe(0x010003a9);
    expect(keysymOfCharacter("€")).toBe(0x010020ac);
    expect(keysymOfCharacter("😀")).toBe(0x0101f600);
  });

  test("text is cut into what xdotool types and what is typed on spare keys", () => {
    expect(runsOf("Γεια σου, Noë!\n")).toEqual([
      { onKeymap: false, text: "Γεια" },
      { onKeymap: true, text: " " },
      { onKeymap: false, text: "σου" },
      { onKeymap: true, text: ", No" },
      { onKeymap: false, text: "ë" },
      { onKeymap: true, text: "!\n" },
    ]);
    expect(runsOf("")).toEqual([]);
  });

  test("a binding is kept and reused, and the one typed longest ago gives way", () => {
    const spares = spareKeycodes([250, 249]);
    const alpha = keysymOfCharacter("α");
    const beta = keysymOfCharacter("β");
    const gamma = keysymOfCharacter("γ");
    expect(spares.bind(alpha)).toEqual({ keycode: 250, fresh: true });
    expect(spares.bind(beta)).toEqual({ keycode: 249, fresh: true });
    expect(spares.bind(alpha)).toEqual({ keycode: 250, fresh: false });
    // β was typed longest ago, so γ takes its keycode.
    expect(spares.bind(gamma)).toEqual({ keycode: 249, fresh: true });
    expect(spares.bind(alpha)).toEqual({ keycode: 250, fresh: false });
    expect(spares.bind(beta)).toEqual({ keycode: 249, fresh: true });
  });

  test("with no keycode spare there is nothing to bind", () => {
    expect(spareKeycodes([]).bind(keysymOfCharacter("α"))).toBeNull();
  });

  test("the empty keycodes are found highest first, leaving the lowest to xdotool", () => {
    // Keycodes 8 to 15, two keysyms each: 8, 10 and 11 hold keys, the rest are empty.
    const keysyms = [
      0x61n,
      0x41n,
      0n,
      0n,
      0x62n,
      0n,
      0x63n,
      0x43n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
    ];
    expect(emptyKeycodes(keysyms, 2, 8, 0)).toEqual([15, 14, 13, 12, 9]);
    expect(emptyKeycodes(keysyms, 2, 8, 2)).toEqual([15, 14, 13]);
  });

  test("xdotool reads its text as UTF-8, whatever the computer was started with", () => {
    const env = xdotoolEnvironment(":1", {
      PATH: "/usr/bin",
      LANG: "C",
      LC_ALL: "C",
      SECRET: "nope",
    });
    expect(env).toEqual({
      DISPLAY: ":1",
      PATH: "/usr/bin",
      LC_CTYPE: "C.UTF-8",
    });
  });
});
