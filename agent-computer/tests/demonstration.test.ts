import { describe, expect, test } from "bun:test";
import {
  gestureForRecording,
  gestureInPage,
  safeDemonstrationUrl,
} from "../src/demonstration";

describe("a gesture made on the desktop", () => {
  // A maximized Chromium on a 1440x900 screen: tab strip and toolbar take the top 87 pixels.
  const view = { focused: true, left: 0, top: 87, width: 1440, height: 813 };

  test("lands in the page under the browser's toolbar", () => {
    expect(gestureInPage(view, { x: 200, y: 300 })).toEqual({
      point: { x: 200, y: 213 },
    });
  });

  test("is the browser's own, not the page's, on the tab strip or the address bar", () => {
    expect(gestureInPage(view, { x: 400, y: 62 })).toBeNull();
    expect(gestureInPage(view, { x: 1440, y: 500 })).toBeNull();
  });

  test("belongs to another window when the browser does not have focus", () => {
    const behind = { ...view, focused: false };
    expect(gestureInPage(behind, { x: 200, y: 300 })).toBeNull();
    expect(gestureInPage(behind, null)).toBeNull();
  });

  test("from the keyboard goes to the focused page, with no point to translate", () => {
    expect(gestureInPage(view, null)).toEqual({ point: null });
  });
});

test("passwords, pasted text and printable key values are never part of a recorded gesture", () => {
  expect(
    gestureForRecording({ type: "text", text: "secret-password" }),
  ).toEqual({ kind: "type" });
  expect(
    gestureForRecording({
      type: "key",
      event: "down",
      key: "s",
      code: "KeyS",
      text: "s",
    }),
  ).toEqual({ kind: "type" });
});
test("pointer movement and releases are not false completed actions", () => {
  expect(
    gestureForRecording({ type: "mouse", event: "moved", x: 1, y: 2 }),
  ).toBeNull();
  expect(
    gestureForRecording({
      type: "key",
      event: "up",
      key: "Enter",
      code: "Enter",
    }),
  ).toBeNull();
});
test("URL provenance omits credentials, query tokens and fragments", () => {
  expect(
    safeDemonstrationUrl(
      "https://user:password@example.test/form?token=secret#secret",
    ),
  ).toBe("https://example.test/form");
});
