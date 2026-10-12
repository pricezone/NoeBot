import { describe, expect, test } from "bun:test";
import { plainSentence, stoppedReason } from "../src/lib/copilot/stopped-turn";

/**
 * What a person is told when a turn ends and no answer came.
 *
 * The cases are the three things that actually arrive: the sentence the deployment's stall watchdog
 * wrote into the run, an error thrown in the browser, and nothing at all.
 */

describe("the reason a turn ended", () => {
  test("passes on what ended the turn, in its own words", () => {
    expect(
      stoppedReason(
        "Risk Analyst stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      ),
    ).toContain("Risk Analyst stopped responding");
  });

  test("reads an Error the same way, because a failed run carries one", () => {
    expect(
      stoppedReason(new Error("The endpoint refused the connection")),
    ).toBe("The endpoint refused the connection");
  });

  test("says so plainly when nothing was reported, rather than inventing a cause", () => {
    // This is the one moment a person has no other way to find out what went wrong, so a guess here
    // would be worse than an admission.
    expect(stoppedReason(undefined)).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason("")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason("   ")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason(new Error(""))).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason({ message: "not a string or an Error" })).toBe(
      "The Bot stopped without saying why.",
    );
  });
});

describe("a run request the runtime refused", () => {
  test("names the conversation service when it did not answer", () => {
    for (const body of [
      '{"error":"Failed to resolve Learning Container"}',
      '{"error":"Failed to initialize thread"}',
    ])
      expect(stoppedReason(`REST run request failed: ${body}`)).toBe(
        "The conversation service did not answer, so this turn could not start. Try again in a moment.",
      );
  });

  test("says another run holds the conversation", () => {
    expect(
      stoppedReason('REST run request failed: {"error":"Thread lock denied"}'),
    ).toBe(
      "Another run is still in progress on this conversation. Wait for it to finish, then try again.",
    );
  });

  test("falls back to one plain sentence for anything else the runtime answered", () => {
    expect(
      stoppedReason(
        "REST run request failed: <html><head><title>502 Bad Gateway</title></head></html>",
      ),
    ).toBe("The Bot could not start this turn. Try again in a moment.");
    expect(
      stoppedReason('REST connect request failed: {"error":"something new"}'),
    ).toBe("The Bot could not start this turn. Try again in a moment.");
  });

  test("leaves a sentence somebody wrote alone", () => {
    expect(plainSentence("The Bot declined: policy")).toBe(
      "The Bot declined: policy",
    );
    expect(plainSentence("")).toBe("");
  });
});
