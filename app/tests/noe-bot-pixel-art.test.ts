import { describe, expect, test } from "bun:test";
import { GRID_16 } from "@/components/noe-bot/drawings";
import {
  AVATAR_SCHEMES,
  decodeHalfBlocks,
  EXPRESSIONS,
  expressionFor,
  facePath,
  pathFor,
  schemeFor,
} from "@/components/noe-bot/pixel-art";

describe("the brand guide's half-block drawings", () => {
  test("every face is 14 by 12 pixels: the 16 grid, and only the 16 grid", () => {
    for (const drawing of [
      GRID_16.body,
      GRID_16.offline,
      ...Object.values(GRID_16.expressions),
    ]) {
      const grid = decodeHalfBlocks(drawing);
      expect([grid.width, grid.height]).toEqual([14, 12]);
    }
    expect(Object.keys(GRID_16.expressions)).toHaveLength(15);
  });

  test("the mascot's capsule eyes are negative space in columns 5 and 8, rows 4 to 7", () => {
    const { rows } = decodeHalfBlocks(GRID_16.body);
    for (const y of [4, 5, 6, 7]) {
      expect(rows[y]?.[5]).toBe(false);
      expect(rows[y]?.[8]).toBe(false);
      // The bar between them, and the cheeks beside them, are ink.
      expect(rows[y]?.[6]).toBe(true);
      expect(rows[y]?.[7]).toBe(true);
      expect(rows[y]?.[3]).toBe(true);
      expect(rows[y]?.[10]).toBe(true);
    }
    // The antennae on the top row.
    expect(rows[0]?.slice(0, 14)).toEqual(
      [0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0].map(Boolean),
    );
  });

  test("an expression changes only the eyes: the body outline is shared", () => {
    const body = decodeHalfBlocks(GRID_16.body);
    for (const [name, drawing] of Object.entries(GRID_16.expressions)) {
      const face = decodeHalfBlocks(drawing);
      // Top and bottom two pixel rows are the antennae and the chin, never the eyes.
      for (const y of [0, 1, 10, 11]) {
        expect({ name, row: face.rows[y] }).toEqual({
          name,
          row: body.rows[y],
        });
      }
    }
  });

  test("a grid becomes one run per stretch of ink", () => {
    expect(
      pathFor({
        width: 5,
        height: 2,
        rows: [
          [true, true, false, true, false],
          [false, false, false, false, true],
        ],
      }),
    ).toBe("M0 0h2v1h-2zM3 0h1v1h-1zM4 1h1v1h-1z");
  });

  test("a face path is cached, and each face is its own drawing", () => {
    expect(facePath("offline")).toBe(facePath("offline"));
    expect(facePath("happy").path).not.toBe(facePath("body").path);
    expect(facePath("offline").path).not.toBe(facePath("body").path);
    expect(facePath("body").width).toBe(14);
    expect(facePath("body").height).toBe(12);
  });
});

describe("what a seed chooses", () => {
  test("the same seed always wears the same face on the same background", () => {
    expect(expressionFor("noe-assistant")).toBe(expressionFor("noe-assistant"));
    expect(schemeFor("noe-assistant")).toBe(schemeFor("noe-assistant"));
  });

  test("a roster of seeds spreads across the expressions and the backgrounds", () => {
    const seeds = Array.from({ length: 60 }, (_, n) => `bot-${n}`);
    const faces = new Set(seeds.map(expressionFor));
    const schemes = new Set(seeds.map(schemeFor));
    expect(faces.size).toBeGreaterThan(EXPRESSIONS.length / 2);
    expect(schemes.size).toBe(AVATAR_SCHEMES.length);
    for (const face of faces) expect(EXPRESSIONS).toContain(face);
  });

  test("only the guide's backgrounds, each with the ink it allows", () => {
    for (const scheme of AVATAR_SCHEMES) {
      expect(["#ff2056", "#18181b", "#f4f4f5"]).toContain(scheme.background);
      if (scheme.background === "#ff2056") expect(scheme.ink).toBe("#ffffff");
    }
  });
});
