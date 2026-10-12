import { describe, expect, test } from "bun:test";
import { ACTS, SEQUENCES } from "@/components/noe-bot/anim/acts";
import { renderBotFrame } from "@/components/noe-bot/anim/bot-frame";
import {
  ACTIONS,
  CATALOG,
  FACE_GROUPS,
  labelFor,
  parseAnimation,
  STATE_IDS,
} from "@/components/noe-bot/anim/catalog";
import { ALL_FACES, EXPR_KEYS, FACES } from "@/components/noe-bot/anim/exprs";
import {
  COLS,
  EAR_LADDER,
  ORIGINAL_FACES,
  ROW_FACE_PX,
} from "@/components/noe-bot/anim/pixels";
import { AVATAR_MAP } from "@/components/noe-bot/anim/rules";

const body = ROW_FACE_PX.original;

describe("the design's pixels", () => {
  test("every face is the same 14 × 12 body with a different pattern of eye holes", () => {
    for (const face of ALL_FACES) {
      const px = FACES[face];
      expect({ face, cells: px?.length }).toEqual({ face, cells: COLS * 12 });
      // Rows 0–1 and 10–11 never change: antennae and chin.
      for (const r of [0, 1, 10, 11]) {
        for (let c = 0; c < COLS; c++) {
          expect({ face, r, c, on: px?.[r * COLS + c] }).toEqual({
            face,
            r,
            c,
            on: body[r * COLS + c],
          });
        }
      }
    }
  });

  test("the brand sheet's 18 faces come first, numbered 00 original … 17 injured", () => {
    expect(ORIGINAL_FACES.slice(0, 18)).toEqual([
      "original",
      "neutral",
      "attentive",
      "surprised",
      "excited",
      "happy",
      "laughing",
      "angry",
      "sad",
      "scared",
      "suspicious",
      "confused",
      "curious",
      "proud",
      "shy",
      "unimpressed",
      "sleepy",
      "injured",
    ]);
    expect(EXPR_KEYS).toHaveLength(35);
    expect(ALL_FACES).toHaveLength(55);
    expect([...ALL_FACES]).toEqual([...AVATAR_MAP.catalog.expressions]);
  });

  test("the catalogue matches avatar-map.json and every id parses", () => {
    expect(ACTIONS.join(",")).toBe(AVATAR_MAP.catalog.actions.join(","));
    expect(STATE_IDS.join(",")).toBe(AVATAR_MAP.catalog.states.join(","));
    expect(CATALOG).toHaveLength(55 + 20 + 9 + 3);
    for (const id of CATALOG) {
      const a = parseAnimation(id);
      if (a.kind === "face") expect(id).toBe(`face:${a.id}`);
      if (a.kind === "action" || a.kind === "state")
        expect(SEQUENCES[a.id]).toBeDefined();
    }
    expect(parseAnimation("face:nope")).toEqual({
      kind: "face",
      id: "original",
    });
    for (const [id, seq] of Object.entries(SEQUENCES)) {
      for (const [act] of seq.segments)
        expect({ id, act, known: act in ACTS }).toEqual({
          id,
          act,
          known: true,
        });
    }
    expect(FACE_GROUPS.map((g) => g.faces.length)).toEqual([20, 6, 7, 8, 8, 6]);
  });
});

describe("one frame as a pure function of time", () => {
  test("every animation renders in both modes without an invalid cell", () => {
    for (const id of CATALOG) {
      for (const mode of ["terminal", "hd"] as const) {
        for (const t of [0, 0.25, 1.3, 2.9, 5.5, 9.9]) {
          const frame = renderBotFrame({
            animation: parseAnimation(id),
            t,
            mode,
            props: true,
            prevFace: "neutral",
          });
          for (const c of frame.cells) {
            expect(
              Number.isFinite(c.x) &&
                Number.isFinite(c.y) &&
                c.w > 0 &&
                c.h > 0,
            ).toBe(true);
          }
          if (id !== "boot" && id !== "rest")
            expect(frame.cells.length).toBeGreaterThan(60);
        }
      }
    }
  });

  test("the same inputs give the same frame", () => {
    const a = renderBotFrame({
      animation: parseAnimation("action:search"),
      t: 2.2,
      mode: "hd",
      props: true,
    });
    const b = renderBotFrame({
      animation: parseAnimation("action:search"),
      t: 2.2,
      mode: "hd",
      props: true,
    });
    expect(a).toEqual(b);
    expect(a.act).toBe("search");
    const late = renderBotFrame({
      animation: parseAnimation("action:search"),
      t: 8,
      mode: "terminal",
      props: true,
    });
    expect(late.act).toBe("detective");
  });

  test("a blink closes the eyes but keeps one lid row: the face never becomes a solid block", () => {
    const open = renderBotFrame({
      animation: parseAnimation("face:neutral"),
      t: 0.5,
      mode: "terminal",
      props: false,
    });
    const closed = renderBotFrame({
      animation: parseAnimation("face:neutral"),
      t: 0.8 + 0.08,
      mode: "terminal",
      props: false,
    });
    const bodyCells = (f: typeof open) =>
      f.cells.filter(
        (c) => c.fill === "P" && c.y >= 2 && c.y <= 9 && c.x >= 1 && c.x <= 12,
      ).length;
    expect(bodyCells(closed)).toBeGreaterThan(bodyCells(open));
    // 8 rows × 12 columns = 96 cells would be a solid block; a lid row stays open.
    expect(bodyCells(closed)).toBeLessThan(96);
    const reduced = renderBotFrame({
      animation: parseAnimation("face:neutral"),
      t: 0.88,
      mode: "terminal",
      props: false,
      reduced: true,
    });
    expect(bodyCells(reduced)).toBe(bodyCells(open));
  });

  test("a change of expression flashes exactly the cells that differ, for two frames", () => {
    const from = FACES.neutral ?? [];
    const to = FACES.surprised ?? [];
    const differing = new Set<string>();
    for (let r = 2; r <= 9; r++)
      for (let c = 1; c <= 12; c++)
        if (!!from[r * COLS + c] !== !!to[r * COLS + c])
          differing.add(`${c},${r}`);
    expect(differing.size).toBeGreaterThan(0);
    const flashing = renderBotFrame({
      animation: parseAnimation("face:surprised"),
      t: 1 / 12,
      mode: "terminal",
      props: false,
      prevFace: "neutral",
    });
    const white = new Set(
      flashing.cells.filter((c) => c.fill === "X").map((c) => `${c.x},${c.y}`),
    );
    expect(white).toEqual(differing);
    const settled = renderBotFrame({
      animation: parseAnimation("face:surprised"),
      t: 3 / 12,
      mode: "terminal",
      props: false,
      prevFace: "neutral",
    });
    expect(settled.cells.some((c) => c.fill === "X")).toBe(false);
  });

  test("ears climb the ladder one step a frame when a face change lifts them two levels or more", () => {
    // sad (droop, h0) → attentive (tall, h4): the left ear reacts one frame later and steps through
    // splay, normal, pointy before tall.
    const earCells = (t: number) =>
      renderBotFrame({
        animation: parseAnimation("face:attentive"),
        t,
        mode: "terminal",
        props: false,
        prevFace: "sad",
      })
        .cells.filter((c) => c.y <= 0 && c.x <= 6 && c.fill === "P")
        .map((c) => `${c.x},${c.y}`)
        .sort();
    const seen = [1, 2, 3, 4, 5, 8].map((f) => earCells(f / 12).join(" "));
    expect(new Set(seen).size).toBeGreaterThanOrEqual(4);
    expect(EAR_LADDER).toEqual(["droop", "splay", "normal", "pointy", "tall"]);
    // After the climb the left ear is tall: four cells, one of them above row 0.
    expect(earCells(1).some((k) => k.endsWith(",-1"))).toBe(true);
  });

  test("props are hidden under 48 px and a tool action still moves the body", () => {
    const small = renderBotFrame({
      animation: parseAnimation("action:terminal"),
      t: 1,
      mode: "terminal",
      props: false,
    });
    const big = renderBotFrame({
      animation: parseAnimation("action:terminal"),
      t: 1,
      mode: "terminal",
      props: true,
    });
    expect(big.cells.length).toBeGreaterThan(small.cells.length);
    expect(small.cells.every((c) => c.x >= -2 && c.x <= 16)).toBe(true);
  });

  test("boot scans in from the top and rest scans out from the bottom", () => {
    const early = renderBotFrame({
      animation: parseAnimation("boot"),
      t: 0.1,
      mode: "terminal",
      props: true,
    });
    const done = renderBotFrame({
      animation: parseAnimation("boot"),
      t: 1.5,
      mode: "terminal",
      props: true,
    });
    expect(early.cells.length).toBeLessThan(done.cells.length);
    expect(Math.max(...early.cells.map((c) => c.y))).toBeLessThan(6);
    const asleep = renderBotFrame({
      animation: parseAnimation("rest"),
      t: 3,
      mode: "terminal",
      props: true,
    });
    expect(asleep.face).toBe("sleepy");
    const gone = renderBotFrame({
      animation: parseAnimation("rest"),
      t: 5.5,
      mode: "terminal",
      props: true,
    });
    expect(gone.cells.length).toBe(0);
  });

  test("every action and state has a label in both languages", () => {
    for (const id of [
      ...ACTIONS.map((a) => `action:${a}`),
      ...STATE_IDS.map((s) => `state:${s}`),
    ]) {
      expect({
        id,
        en: labelFor(id, "en") !== undefined,
        el: labelFor(id, "el") !== undefined,
      }).toEqual({ id, en: true, el: true });
    }
  });
});

describe("the mascot at rest and the portraits", () => {
  const faces = CATALOG.filter((id) => id.startsWith("face:")).map((id) =>
    id.slice(5),
  );
  const still = (face: string) =>
    renderBotFrame({
      animation: { kind: "face", id: face },
      t: 0,
      mode: "terminal",
      props: false,
      still: true,
    });

  test("idle is 00 Neutral with a glance to 01 and 02 every 20 s, and loops", () => {
    const at = (t: number) =>
      renderBotFrame({
        animation: parseAnimation("idle"),
        t,
        mode: "terminal",
        props: true,
      });
    expect(at(0).face).toBe("original");
    expect(at(7.5).face).toBe("neutral");
    expect(at(10).face).toBe("original");
    expect(at(15.5).face).toBe("attentive");
    expect(at(20.5).face).toBe("original");
    expect(at(27.5).face).toBe("neutral");
    // The second pass does not flash: the face before its first cue is the original face itself.
    expect(at(20.05).cells.some((c) => c.fill === "X")).toBe(false);
    // The glance itself does flash, as any face change does.
    expect(at(7.05).cells.some((c) => c.fill === "X")).toBe(true);
  });

  test("every face's portrait is centred, settled and has open eyes", () => {
    for (const face of faces) {
      const frame = still(face);
      expect({ face, bx: frame.bx, by: frame.by }).toEqual({
        face,
        bx: 0,
        by: 0,
      });
      // No blink, no glitch in a portrait.
      expect(frame.cells.some((c) => c.fill === "X")).toBe(false);
      // The eye region is never a solid block: at least two cells (scared's pinpoint eyes) show the
      // background or a prop drawn over the body (shades, hearts, stars, glasses).
      const region = (c: (typeof frame.cells)[number]) =>
        c.y >= 2 && c.y <= 9 && c.x >= 1 && c.x <= 12;
      const covered = new Set(
        frame.cells
          .filter((c) => c.fill !== "P" && region(c))
          .map((c) => `${c.x},${c.y}`),
      );
      const ink = new Set(
        frame.cells
          .filter((c) => c.fill === "P" && region(c))
          .map((c) => `${c.x},${c.y}`)
          .filter((key) => !covered.has(key)),
      );
      const open = 8 * 12 - ink.size;
      expect({ face, open: open >= 2 }).toEqual({ face, open: true });
    }
  });

  test("the portraits the frame-0 capture got wrong are right", () => {
    // in-love and star-struck draw their eyes as props: kept even with props hidden.
    expect(
      still("in-love").cells.some(
        (c) => c.fill === "W" && c.y >= 4 && c.y <= 7,
      ),
    ).toBe(true);
    expect(still("star-struck").cells.some((c) => c.fill === "W")).toBe(true);
    // cool's shades sit on row 4 once dropped in.
    expect(still("cool").cells.some((c) => c.fill === "D" && c.y === 4)).toBe(
      true,
    );
    // eye-roll: eyes rolled up, at the top of the eye region.
    const rolled = still("eye-roll");
    const holes = [];
    for (let r = 2; r <= 9; r++)
      for (let c = 1; c <= 12; c++) {
        if (
          !rolled.cells.some(
            (cell) => cell.fill === "P" && cell.x === c && cell.y === r,
          )
        )
          holes.push(r);
      }
    expect(Math.min(...holes)).toBe(2);
    // hug: arms at the sides, not flung out past the body.
    expect(still("hug").cells.every((c) => c.x >= -1 && c.x <= 14)).toBe(true);
    // angry at frame 0 used to sit a cell left; a portrait does not.
    expect(still("angry").bx).toBe(0);
  });
});
