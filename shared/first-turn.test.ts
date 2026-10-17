import { describe, expect, test } from "bun:test";
import { FIRST_TURN_COPY, frameFirstTurn, isFirstTurn } from "./first-turn";
import { SELF_PROFILE_TOOL } from "./self-profile";

/**
 * The frame of a new Bot's first turn: ask, end the turn, and only on the person's answer help,
 * name itself and suggest what else would help.
 */

describe("the first turn's frame", () => {
  for (const locale of ["en", "el"] as const) {
    const frame = frameFirstTurn(locale);
    const copy = FIRST_TURN_COPY[locale];

    test(`${locale}: asks with ask_person and its options, and ends the turn there`, () => {
      expect(frame).toContain(`"${copy.question}"`);
      for (const option of copy.options) expect(frame).toContain(option);
      expect(frame).toContain("call ask_person");
      expect(frame).toContain("The call ends your turn");
    });

    test(`${locale}: waits for the answer before helping and naming itself`, () => {
      const answer = frame.indexOf("Only once their answer arrives");
      expect(answer).toBeGreaterThan(frame.indexOf("call ask_person"));
      expect(frame.indexOf(`call ${SELF_PROFILE_TOOL}`)).toBeGreaterThan(
        answer,
      );
      expect(frame).toContain("help with that straight away");
    });

    test(`${locale}: a name of whole words in the person's language, never cut short`, () => {
      expect(frame).toContain("one or two whole words");
      expect(frame).toContain("in the person's language");
      expect(frame).toContain("never abbreviated or cut short");
      expect(frame).not.toContain("short name");
      expect(frame).not.toContain("you cannot do it for them");
    });

    test(`${locale}: suggests templates and marketplace items only if it has the tools`, () => {
      for (const tool of [
        "find_bot_templates",
        "offer_bot_template",
        "find_marketplace_items",
        "offer_marketplace_item",
      ])
        expect(frame).toContain(tool);
      expect(frame).toContain("if you have them");
    });

    test(`${locale}: is still recognised as the frame`, () => {
      expect(isFirstTurn(frame)).toBe(true);
    });
  }

  test("the Greek frame shows a Greek cut-off word as the thing to avoid", () => {
    expect(frameFirstTurn("el")).toContain('never "Διεκπ."');
    expect(frameFirstTurn("el")).toContain("Write it all in Greek");
  });
});
