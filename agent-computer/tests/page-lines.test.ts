import { describe, expect, test } from "bun:test";
import type { SnapshotElement } from "../src/aria-snapshot";
import {
  changedElements,
  compactLines,
  elementLine,
  pageLines,
} from "../src/page-lines";

/**
 * The page an acting call hands back, as the few lines a model reads: one line per element,
 * identical controls merged without losing a ref, and only what changed when the page stayed put.
 */
const button = (ref: string, name: string): SnapshotElement => ({
  ref,
  role: "button",
  name,
});

describe("one element as one line", () => {
  test("says the role, the label, the value and the state", () => {
    expect(
      elementLine({
        ref: "e5",
        role: "textbox",
        name: "Email",
        value: "a@b.c",
      }),
    ).toBe('e5 textbox "Email" = "a@b.c"');
    expect(
      elementLine({
        ref: "e7",
        role: "checkbox",
        name: "Agree",
        checked: false,
        disabled: true,
      }),
    ).toBe('e7 checkbox "Agree" [unchecked] [disabled]');
  });

  test("a drop-down lists its options, within a budget", () => {
    const options = Array.from(
      { length: 80 },
      (_, index) => `Country ${index}`,
    );
    const line = elementLine({
      ref: "e2",
      role: "combobox",
      name: "Country",
      value: "Country 0",
      options,
    });
    expect(line).toStartWith(
      'e2 combobox "Country" = "Country 0" options: Country 0 | Country 1',
    );
    expect(line).toMatch(/\| \+\d+ more$/);
    expect(line.length).toBeLessThan(450);
  });

  test("a long label is cut at 80 characters and says so", () => {
    const line = elementLine(button("e1", "x".repeat(200)));
    expect(line).toBe(`e1 button "${"x".repeat(80)}…"`);
  });
});

describe("the list", () => {
  test("identical controls are one line that still names every ref", () => {
    const lines = compactLines([
      button("e1", "Read more"),
      button("e2", "Buy"),
      button("e3", "Read more"),
      button("e4", "Read more"),
    ]);
    expect(lines).toEqual([
      'e1 button "Read more" (also e3, e4)',
      'e2 button "Buy"',
    ]);
  });

  test("past eight extra refs the rest are counted", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      button(`e${index}`, "More"),
    );
    expect(compactLines(many)).toEqual([
      'e0 button "More" (also e1, e2, e3, e4, e5, e6, e7, e8 and 3 more)',
    ]);
  });
});

describe("what changed", () => {
  const before = [
    button("e1", "Add to basket"),
    { ref: "e2", role: "textbox", name: "Qty", value: "1" },
    button("e3", "Help"),
    button("e4", "Contact"),
  ];

  test("new and changed elements are listed, unchanged ones are not", () => {
    const after = [
      button("e1", "Add to basket"),
      { ref: "e2", role: "textbox", name: "Qty", value: "2" },
      button("e3", "Help"),
      button("e4", "Contact"),
      button("e9", "Go to basket"),
    ];
    expect(
      changedElements(before, after).map((element) => element.ref),
    ).toEqual(["e2", "e9"]);
    expect(
      pageLines(
        { url: "https://shop.test/", elements: before },
        { url: "https://shop.test/", elements: after },
      ),
    ).toEqual({
      elements: ['e2 textbox "Qty" = "2"', 'e9 button "Go to basket"'],
      changed: true,
    });
  });

  test("nothing changed is an empty diff, still marked", () => {
    expect(
      pageLines(
        { url: "https://shop.test/", elements: before },
        { url: "https://shop.test/", elements: before },
      ),
    ).toEqual({ elements: [], changed: true });
  });

  test("a different page, or no page before, is the whole list", () => {
    const next = { url: "https://shop.test/basket", elements: before };
    expect(
      pageLines({ url: "https://shop.test/", elements: before }, next).changed,
    ).toBeUndefined();
    expect(pageLines(undefined, next).elements).toHaveLength(4);
  });

  test("a page that mostly changed in place is the whole list too", () => {
    const replaced = [
      button("e10", "One"),
      button("e11", "Two"),
      button("e12", "Three"),
      button("e1", "Add to basket"),
    ];
    const lines = pageLines(
      { url: "https://app.test/", elements: before },
      { url: "https://app.test/", elements: replaced },
    );
    expect(lines.changed).toBeUndefined();
    expect(lines.elements).toHaveLength(4);
  });
});
