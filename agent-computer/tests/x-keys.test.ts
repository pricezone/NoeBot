import { describe, expect, test } from "bun:test";
import { wheelClicks, xKeyFor } from "../src/x-keys";

describe("a browser key as an X key", () => {
  test("a letter goes through the key under the finger, shifted or not", () => {
    expect(xKeyFor({ key: "a", code: "KeyA" })).toEqual({
      kind: "keysym",
      keysym: "a",
    });
    // The surface forwards Shift as a key of its own, so the server does the shifting.
    expect(xKeyFor({ key: "A", code: "KeyA" })).toEqual({
      kind: "keysym",
      keysym: "a",
    });
    expect(xKeyFor({ key: "!", code: "Digit1" })).toEqual({
      kind: "keysym",
      keysym: "1",
    });
    expect(xKeyFor({ key: "'", code: "Quote" })).toEqual({
      kind: "keysym",
      keysym: "apostrophe",
    });
    expect(xKeyFor({ key: " ", code: "Space" })).toEqual({
      kind: "keysym",
      keysym: "space",
    });
  });

  test("editing and navigation keys use their X names", () => {
    expect(xKeyFor({ key: "Enter", code: "Enter" })).toEqual({
      kind: "keysym",
      keysym: "Return",
    });
    expect(xKeyFor({ key: "Backspace", code: "Backspace" })).toEqual({
      kind: "keysym",
      keysym: "BackSpace",
    });
    expect(xKeyFor({ key: "PageDown", code: "PageDown" })).toEqual({
      kind: "keysym",
      keysym: "Next",
    });
    expect(xKeyFor({ key: "ArrowLeft", code: "ArrowLeft" })).toEqual({
      kind: "keysym",
      keysym: "Left",
    });
    expect(xKeyFor({ key: "F5", code: "F5" })).toEqual({
      kind: "keysym",
      keysym: "F5",
    });
    expect(xKeyFor({ key: "Enter", code: "NumpadEnter" })).toEqual({
      kind: "keysym",
      keysym: "Return",
    });
  });

  test("modifiers keep their side", () => {
    expect(xKeyFor({ key: "Shift", code: "ShiftRight" })).toEqual({
      kind: "keysym",
      keysym: "Shift_R",
    });
    expect(xKeyFor({ key: "Control", code: "ControlLeft" })).toEqual({
      kind: "keysym",
      keysym: "Control_L",
    });
    expect(xKeyFor({ key: "Meta", code: "MetaLeft" })).toEqual({
      kind: "keysym",
      keysym: "Super_L",
    });
  });

  test("a character the US key would not type is typed as text", () => {
    expect(xKeyFor({ key: "α", code: "KeyA" })).toEqual({
      kind: "text",
      text: "α",
    });
    expect(xKeyFor({ key: "é", code: "KeyE" })).toEqual({
      kind: "text",
      text: "é",
    });
    expect(xKeyFor({ key: "€", code: "Digit4" })).toEqual({
      kind: "text",
      text: "€",
    });
  });

  test("with Control or Command held, a key is the shortcut under the finger, whatever the layout writes", () => {
    // Control and the C key on a Greek layout: Copy, not a ψ typed into the page.
    expect(xKeyFor({ key: "ψ", code: "KeyC", modifiers: 2 })).toEqual({
      kind: "keysym",
      keysym: "c",
    });
    expect(xKeyFor({ key: "ω", code: "KeyV", modifiers: 2 | 8 })).toEqual({
      kind: "keysym",
      keysym: "v",
    });
    // Control with Alt is AltGr writing a character, and that character is typed.
    expect(xKeyFor({ key: "€", code: "KeyE", modifiers: 2 | 1 })).toEqual({
      kind: "text",
      text: "€",
    });
    // Shift alone shifts; it makes no shortcut.
    expect(xKeyFor({ key: "Α", code: "KeyA", modifiers: 8 })).toEqual({
      kind: "text",
      text: "Α",
    });
  });

  test("keys with no meaning on the desktop send nothing", () => {
    expect(xKeyFor({ key: "Dead", code: "Quote" })).toEqual({ kind: "none" });
    expect(xKeyFor({ key: "Process", code: "KeyA" })).toEqual({ kind: "none" });
    expect(xKeyFor({ key: "MediaPlayPause", code: "MediaPlayPause" })).toEqual({
      kind: "none",
    });
  });
});

describe("a wheel turn as X buttons", () => {
  test("down is button 5, up is 4, with one click per notch", () => {
    expect(wheelClicks(0, 100)).toEqual([{ button: 5, times: 1 }]);
    expect(wheelClicks(0, -250)).toEqual([{ button: 4, times: 3 }]);
    expect(wheelClicks(0, 3)).toEqual([{ button: 5, times: 1 }]);
  });

  test("sideways is 6 and 7, and both axes can turn at once", () => {
    expect(wheelClicks(-100, 100)).toEqual([
      { button: 5, times: 1 },
      { button: 6, times: 1 },
    ]);
    expect(wheelClicks(5000, 0)).toEqual([{ button: 7, times: 10 }]);
  });

  test("a turn of nothing presses nothing", () => {
    expect(wheelClicks(0, 0)).toEqual([]);
  });
});
