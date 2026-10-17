import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  awaitsContinuation,
  runWithContinuationRetry,
} from "@/lib/copilot/continuation-retry";
import { ANSWERED_IN_CHAT, UNANSWERED } from "@/lib/copilot/repair-history";

/**
 * A question still waiting on the person ends the Bot's turn, so the browser's continuation retry
 * never runs the model again after one: run again on its own question, the Bot answered it itself.
 * A decision card answered ON the card is not waiting: its follow-up is the Bot reading the answer,
 * and one that failed or came back empty is retried and then reported, as before.
 */

const BEFORE = new Set(["u1"]);
const followsUp = () => true;
const PUT = JSON.stringify("Put to the person in this conversation.");

/** A turn whose Bot called `name` and got `result`, with any further results after it. */
function ending(
  name: string,
  result: string,
  extra: Message[] = [],
): Message[] {
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
    { id: "t1", role: "tool", toolCallId: "call-1", content: result },
    ...extra,
  ];
}

describe("a turn that ended on a question still waiting", () => {
  test("ask_person put to the person is not awaiting a continuation", () => {
    expect(
      awaitsContinuation(ending("ask_person", PUT), BEFORE, followsUp),
    ).toBe(false);
  });

  test.each([
    ["askChoice", UNANSWERED],
    ["askApproval", ANSWERED_IN_CHAT],
    ["askChoice", JSON.stringify("Forwarded to client")],
  ])(
    "%s with only a stand-in or placeholder (%s) is not either",
    (name, result) => {
      expect(awaitsContinuation(ending(name, result), BEFORE, followsUp)).toBe(
        false,
      );
    },
  );

  test("nor is one whose question was put alongside a browser step", () => {
    const messages = ending("ask_person", PUT, [
      { id: "t2", role: "tool", toolCallId: "call-2", content: '{"ok":true}' },
    ]);
    expect(awaitsContinuation(messages, BEFORE, followsUp)).toBe(false);
  });

  test("the turn is run once, and not again", async () => {
    let runs = 0;
    const agent = {
      messages: ending("ask_person", PUT),
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

describe("a turn that ended on an answered card", () => {
  test.each([
    ["askApproval", JSON.stringify({ decision: "approved" })],
    ["askApproval", JSON.stringify({ decision: "declined", note: "Not now" })],
    ["askChoice", JSON.stringify({ choice: "staging", label: "Staging" })],
  ])(
    "%s answered on the card (%s) is awaiting its follow-up",
    (name, result) => {
      expect(awaitsContinuation(ending(name, result), BEFORE, followsUp)).toBe(
        true,
      );
    },
  );

  test("a refused ask_person is followed up like any other result", () => {
    expect(
      awaitsContinuation(
        ending("ask_person", JSON.stringify("That did not reach anybody.")),
        BEFORE,
        followsUp,
      ),
    ).toBe(true);
  });

  test("a silent follow-up after the card is retried once, then reported", async () => {
    let runs = 0;
    const agent = {
      messages: ending("askApproval", JSON.stringify({ decision: "approved" })),
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

    expect(runs).toBe(2);
    expect(failure).toBeString();
  });
});

describe("a browser step", () => {
  test("alone still awaits its continuation", () => {
    expect(
      awaitsContinuation(
        ending("computer_click", '{"ok":true}'),
        BEFORE,
        followsUp,
      ),
    ).toBe(true);
  });
});
