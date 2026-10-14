import { describe, expect, test } from "bun:test";
import {
  clipRect,
  fitWidth,
  frameWidthFrom,
  pageOffset,
  pageRectToScreen,
  screenPointToPage,
  smallestContaining,
  visibleIn,
  windowPlacement,
} from "../src/element-geometry";
import { xKeysForCombo } from "../src/x-keys";

/*
 * Clicky draws on the screen and acts at screen points; the page's elements are measured in the
 * page. On a desktop the two differ by where the browser's viewport starts, below its tab strip and
 * toolbar, wherever its window is.
 */
const maximized = {
  screenX: 0,
  screenY: 0,
  outerWidth: 1440,
  outerHeight: 900,
  innerWidth: 1440,
  innerHeight: 813,
};

describe("page and screen", () => {
  test("a maximized browser's page starts below its toolbar", () => {
    expect(pageOffset(maximized)).toEqual({ x: 0, y: 87 });
    expect(windowPlacement(maximized)).toEqual({
      x: 0,
      y: 0,
      innerOffsetX: 0,
      innerOffsetY: 87,
    });
  });

  test("a window moved across the screen moves its page with it", () => {
    const offset = pageOffset({
      ...maximized,
      screenX: 200,
      screenY: 40,
      outerWidth: 1000,
      innerWidth: 1000,
      outerHeight: 700,
      innerHeight: 613,
    });
    expect(offset).toEqual({ x: 200, y: 127 });
    expect(
      pageRectToScreen({ x: 10, y: 20, width: 100, height: 30 }, offset),
    ).toEqual({ x: 210, y: 147, width: 100, height: 30 });
  });

  test("a screen point maps into the page, and off the page maps to nothing", () => {
    const offset = { x: 0, y: 87 };
    const viewport = { width: 1440, height: 813 };
    expect(screenPointToPage({ x: 100, y: 100 }, offset, viewport)).toEqual({
      x: 100,
      y: 13,
    });
    // The address bar is the browser's, not the page's.
    expect(screenPointToPage({ x: 100, y: 40 }, offset, viewport)).toBeNull();
    expect(screenPointToPage({ x: 1440, y: 500 }, offset, viewport)).toBeNull();
    expect(screenPointToPage({ x: 5, y: 899 }, offset, viewport)).toEqual({
      x: 5,
      y: 812,
    });
  });

  test("a nonsense window reading does not move the page off the screen", () => {
    expect(
      pageOffset({
        ...maximized,
        screenX: Number.NaN,
        outerHeight: 700,
        innerHeight: 813,
      }),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("boxes", () => {
  const screen = { width: 1440, height: 900 };

  test("only boxes with area inside the bounds are visible", () => {
    expect(visibleIn({ x: 10, y: 10, width: 20, height: 20 }, screen)).toBe(
      true,
    );
    expect(visibleIn({ x: 10, y: 950, width: 20, height: 20 }, screen)).toBe(
      false,
    );
    expect(visibleIn({ x: -30, y: 10, width: 20, height: 20 }, screen)).toBe(
      false,
    );
    expect(visibleIn({ x: 10, y: 10, width: 0, height: 20 }, screen)).toBe(
      false,
    );
    // Half off the top still shows its lower half.
    expect(visibleIn({ x: 10, y: -10, width: 20, height: 20 }, screen)).toBe(
      true,
    );
  });

  test("a box is clipped to the screen", () => {
    expect(
      clipRect({ x: -10, y: 880, width: 100, height: 40 }, screen),
    ).toEqual({ x: 0, y: 880, width: 90, height: 20 });
  });

  test("the innermost box under a point wins", () => {
    const card = {
      ref: "e1",
      rect: { x: 0, y: 0, width: 400, height: 300 },
    };
    const button = {
      ref: "e2",
      rect: { x: 100, y: 100, width: 80, height: 30 },
    };
    expect(smallestContaining({ x: 120, y: 110 }, [card, button])?.ref).toBe(
      "e2",
    );
    expect(smallestContaining({ x: 10, y: 10 }, [card, button])?.ref).toBe(
      "e1",
    );
    expect(smallestContaining({ x: 500, y: 10 }, [card, button])).toBe(
      undefined,
    );
  });
});

describe("frames for the model", () => {
  test("a frame is never wider than asked and never enlarged", () => {
    expect(fitWidth({ width: 1440, height: 900 }, 1280)).toEqual({
      width: 1280,
      height: 800,
      scale: 1280 / 1440,
    });
    expect(fitWidth({ width: 1024, height: 768 }, 1280)).toEqual({
      width: 1024,
      height: 768,
      scale: 1,
    });
    const thumb = fitWidth({ width: 1440, height: 900 }, 321);
    expect(thumb.width % 2).toBe(0);
    expect(thumb.height % 2).toBe(0);
  });

  test("?width= is a whole number clamped into range, or the default", () => {
    const range = { fallback: 1280, min: 160, max: 1440 };
    expect(frameWidthFrom(null, range)).toBe(1280);
    expect(frameWidthFrom("", range)).toBe(1280);
    expect(frameWidthFrom("abc", range)).toBe(1280);
    expect(frameWidthFrom("12.5", range)).toBe(1280);
    expect(frameWidthFrom("40", range)).toBe(160);
    expect(frameWidthFrom("99999", range)).toBe(1440);
    expect(frameWidthFrom("640", range)).toBe(640);
  });
});

describe("keys Clicky presses on the desktop", () => {
  test("Playwright's names become X keysyms, modifiers first", () => {
    expect(xKeysForCombo("Enter")).toEqual({
      kind: "keysyms",
      keysyms: ["Return"],
    });
    expect(xKeysForCombo("Control+L")).toEqual({
      kind: "keysyms",
      keysyms: ["Control_L", "Shift_L", "l"],
    });
    expect(xKeysForCombo("Control+l")).toEqual({
      kind: "keysyms",
      keysyms: ["Control_L", "l"],
    });
    expect(xKeysForCombo("Shift+Tab")).toEqual({
      kind: "keysyms",
      keysyms: ["Shift_L", "Tab"],
    });
    expect(xKeysForCombo("Control+KeyW")).toEqual({
      kind: "keysyms",
      keysyms: ["Control_L", "w"],
    });
    expect(xKeysForCombo("Space")).toEqual({
      kind: "keysyms",
      keysyms: ["space"],
    });
    expect(xKeysForCombo("+")).toEqual({
      kind: "keysyms",
      keysyms: ["Shift_L", "equal"],
    });
  });

  test("a character the keymap lacks is typed, and nonsense is pressed not at all", () => {
    expect(xKeysForCombo("α")).toEqual({ kind: "text", text: "α" });
    expect(xKeysForCombo("Hyper+Q")).toBeNull();
    expect(xKeysForCombo("Control+α")).toBeNull();
    expect(xKeysForCombo("Control++")).toEqual({
      kind: "keysyms",
      keysyms: ["Control_L", "Shift_L", "equal"],
    });
    expect(xKeysForCombo("")).toBeNull();
    expect(xKeysForCombo("NotAKey")).toBeNull();
  });
});
