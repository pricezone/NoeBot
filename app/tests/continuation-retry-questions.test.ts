import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  awaitsContinuation,
  runWithContinuationRetry,
} from "@/lib/copilot/continuation-retry";

/**
 * A question to the person ends the Bot's turn, so the browser's continuation retry never runs the
 * model again after one: run again on its own question, the Bot answered it itself.
 */

const BEFORE = new Set(["u1"]);
const followsUp = () => true;

function ending(name: string, extra: Message[] = []): Message[] {
  return [
    { id: "u1", role: "user", content: "Help me." },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name, arguments: "{}" },
        },
        ...extra.flatMap((message) =>
          message.role === "tool"
            ? [
                {
                  id: message.toolCallId,
                  type: "function" as const,
                  function: { name: "computer_click", arguments: "{}" },
                },
              ]
            : [],
        ),
      ],
    },
    {
      id: "t1",
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify("Put to the person in this conversation."),
    },
    ...extra,
  ];
}

describe("a turn that ended on a question", () => {
  test.each(["ask_person", "askChoice", "askApproval"])(
    "%s is not awaiting a continuation",
    (name) => {
      expect(awaitsContinuation(ending(name), BEFORE, followsUp)).toBe(false);
    },
  );

  test("nor is one whose question was answered alongside a browser step", () => {
    const messages = ending("ask_person", [
      { id: "t2", role: "tool", toolCallId: "call-2", content: '{"ok":true}' },
    ]);
    expect(awaitsContinuation(messages, BEFORE, followsUp)).toBe(false);
  });

  test("a browser step alone still is", () => {
    expect(
      awaitsContinuation(ending("computer_click"), BEFORE, followsUp),
    ).toBe(true);
  });

  test("the turn is run once, and not again", async () => {
    let runs = 0;
    const agent = {
      messages: ending("ask_person"),
      subscribe: () => ({ unsubscribe: () => undefined }),
    };

    const failure = await runWithContinuationRetry({
      agent,
      run: async () => {
        runs += 1;
      },
      before: BEFORE,
      followsUp,
      stopped: () => false,
    });

    expect(failure).toBeNull();
    expect(runs).toBe(1);
  });
});
