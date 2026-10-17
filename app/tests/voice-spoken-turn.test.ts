import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { spokenTurn } from "@/lib/voice/agent-bridge";

/**
 * What a voice caller hears of a turn. A question to the person ends the Bot's turn with nothing
 * said after it, and its card is not something a caller can see, so the question is said too.
 */

const BEFORE = new Set(["u1"]);
const PUT = JSON.stringify("Put to the person in this conversation.");

function turn(said: string, args: unknown, result: string): Message[] {
  return [
    { id: "u1", role: "user", content: "Book me a train." },
    {
      id: "a1",
      role: "assistant",
      content: said,
      toolCalls: [
        {
          id: "q1",
          type: "function",
          function: { name: "ask_person", arguments: JSON.stringify(args) },
        },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "q1", content: result },
  ];
}

describe("a voice turn that ended on a question", () => {
  test("with no words of its own, is heard as the question", () => {
    expect(
      spokenTurn(turn("", { question: "Is 9:40 all right?" }, PUT), BEFORE),
    ).toBe("Is 9:40 all right?");
  });

  test("with options, is heard with them", () => {
    expect(
      spokenTurn(
        turn(
          "Two trains fit.",
          { question: "Which one?", options: ["9:40", "10:15"] },
          PUT,
        ),
        BEFORE,
      ),
    ).toBe("Two trains fit.\n\nWhich one? (9:40, 10:15)");
  });

  test("is not heard twice when the Bot already said it", () => {
    expect(
      spokenTurn(
        turn("Is 9:40 all right?", { question: "Is 9:40 all right?" }, PUT),
        BEFORE,
      ),
    ).toBe("Is 9:40 all right?");
  });

  test("that reached nobody is not heard as asked", () => {
    expect(
      spokenTurn(
        turn(
          "",
          { question: "Is 9:40 all right?" },
          JSON.stringify("That did not reach anybody."),
        ),
        BEFORE,
      ),
    ).toBe("");
  });

  test("an ordinary turn is heard as its words", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: "Hi" },
      { id: "a1", role: "assistant", content: "Hello." },
    ];
    expect(spokenTurn(messages, BEFORE)).toBe("Hello.");
  });
});
