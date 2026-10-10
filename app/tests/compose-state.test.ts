import { describe, expect, test } from "bun:test";
import {
  addRecipient,
  canSend,
  MAX_GROUP_RECIPIENTS,
  MAX_RECIPIENTS,
  removeRecipient,
} from "../src/components/channels/compose-state";

const KNOWLEDGE = { id: "knowledge", name: "Knowledge" };
const RISK = { id: "risk-analyst", name: "Risk Analyst" };

describe("addRecipient", () => {
  test("adds to an empty list", () => {
    expect(addRecipient([], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });

  test("replaces rather than appends once the cap is reached", () => {
    // One coworker per channel today; a second pick replaces the first.
    expect(addRecipient([KNOWLEDGE], RISK)).toEqual([RISK]);
  });

  test("adding the coworker already chosen is a no-op", () => {
    expect(addRecipient([KNOWLEDGE], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });
});

describe("removeRecipient", () => {
  test("removes by id", () => {
    expect(removeRecipient([KNOWLEDGE], "knowledge")).toEqual([]);
  });

  test("ignores an id that is not present", () => {
    expect(removeRecipient([KNOWLEDGE], "nobody")).toEqual([KNOWLEDGE]);
  });
});

describe("canSend", () => {
  test("needs exactly one recipient and some text", () => {
    expect(canSend([KNOWLEDGE], "hello")).toBe(true);
  });

  test("refuses with no recipient", () => {
    expect(canSend([], "hello")).toBe(false);
  });

  test("refuses whitespace-only text", () => {
    expect(canSend([KNOWLEDGE], "   ")).toBe(false);
  });

  test("cap is one", () => {
    expect(MAX_RECIPIENTS).toBe(1);
  });
});

describe("group mode", () => {
  const bots = Array.from({ length: MAX_GROUP_RECIPIENTS + 1 }, (_, index) => ({
    id: `bot-${index}`,
    name: `Bot ${index}`,
  }));

  test("holds up to twenty, the most a group takes", () => {
    expect(MAX_GROUP_RECIPIENTS).toBe(20);
    expect(addRecipient([KNOWLEDGE], RISK, MAX_GROUP_RECIPIENTS)).toEqual([
      KNOWLEDGE,
      RISK,
    ]);
  });

  test("sends with one Bot, as a direct conversation, and with up to twenty", () => {
    expect(canSend([KNOWLEDGE], "hello", true)).toBe(true);
    expect(canSend([KNOWLEDGE, RISK], "hello", true)).toBe(true);
    expect(canSend(bots.slice(0, MAX_GROUP_RECIPIENTS), "hello", true)).toBe(
      true,
    );
  });

  test("refuses none, and more than twenty", () => {
    expect(canSend([], "hello", true)).toBe(false);
    expect(canSend(bots, "hello", true)).toBe(false);
  });

  test("outside it, two Bots still cannot send", () => {
    expect(canSend([KNOWLEDGE, RISK], "hello")).toBe(false);
  });
});
