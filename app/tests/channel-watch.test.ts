import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  browsedSince,
  endsOnToolResult,
  liveCalls,
  unfinishedTurn,
} from "@/lib/channels/watch";
import { clearActivity, recordActivity } from "@/lib/computers/activity";

/**
 * What a conversation's own transcript says about the cards in it: which calls are still open (so
 * the server's copy of the same request is not drawn twice), and whether the last turn stopped half
 * way — the Bot ran a tool, the result came back, and it said nothing after it while nothing waits
 * on the person.
 */

const asked = (id: string, name: string, args: unknown = {}): Message => ({
  id: `assistant-${id}`,
  role: "assistant",
  toolCalls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const result = (id: string, content = '{"ok":true}'): Message => ({
  id: `tool-${id}`,
  role: "tool",
  toolCallId: id,
  content,
});
const person: Message = { id: "user-1", role: "user", content: "Go on" };

describe("live calls", () => {
  test("a call with no result is open, with its tool and arguments; one with a result is not", () => {
    const live = liveCalls([
      asked("call-1", "computer_request_secret", { ref: "e12", snapshotId: 3 }),
      asked("call-2", "computer_click"),
      result("call-2"),
    ]);
    expect([...live.ids]).toEqual(["call-1", "call-2"]);
    expect([...live.open.keys()]).toEqual(["call-1"]);
    expect(live.open.get("call-1")).toEqual({
      name: "computer_request_secret",
      args: { ref: "e12", snapshotId: 3 },
    });
  });

  test("the runtime's forwarded placeholder leaves a decision open, and closes every other card", () => {
    const live = liveCalls([
      asked("choice", "askChoice", { title: "Which?" }),
      result("choice", "Forwarded to client"),
      asked("secret", "computer_request_secret"),
      result("secret", JSON.stringify("Forwarded to client")),
    ]);
    expect(live.open.has("choice")).toBe(true);
    expect(live.open.has("secret")).toBe(false);
  });

  test("a question with nothing said after it is open, by its words", () => {
    const question = asked("ask", "ask_person", { question: "Which account?" });
    expect([...liveCalls([question]).questions]).toEqual(["Which account?"]);
    expect(liveCalls([question, person]).questions.size).toBe(0);
  });
});

describe("a turn that stopped before finishing", () => {
  test("ends on a tool result with nothing said after it", () => {
    const messages = [
      person,
      asked("click", "computer_click"),
      result("click"),
    ];
    expect(endsOnToolResult(messages)).toBe(true);
    expect(unfinishedTurn({ messages, running: false })).toBe(true);
  });

  test("not while anything is still running", () => {
    const messages = [
      person,
      asked("click", "computer_click"),
      result("click"),
    ];
    expect(unfinishedTurn({ messages, running: true })).toBe(false);
  });

  test("not when the Bot said something after the result, or the person spoke since", () => {
    const after: Message = {
      id: "reply",
      role: "assistant",
      content: "Done: the form is submitted.",
    };
    expect(
      unfinishedTurn({
        messages: [person, asked("c", "computer_click"), result("c"), after],
        running: false,
      }),
    ).toBe(false);
    expect(
      unfinishedTurn({
        messages: [asked("c", "computer_click"), result("c"), person],
        running: false,
      }),
    ).toBe(false);
  });

  test("looks past blank assistant turns and system rows", () => {
    const blank: Message = { id: "blank", role: "assistant", content: "" };
    const system: Message = { id: "sys", role: "system", content: "Skill" };
    expect(
      unfinishedTurn({
        messages: [
          person,
          asked("c", "computer_click"),
          result("c"),
          blank,
          system,
        ],
        running: false,
      }),
    ).toBe(true);
  });

  test("not when something waits on the person: an open card, or a question", () => {
    expect(
      unfinishedTurn({
        messages: [
          asked("choice", "askChoice", { title: "Which?" }),
          asked("c", "computer_click"),
          result("c"),
        ],
        running: false,
      }),
    ).toBe(false);
    expect(
      unfinishedTurn({
        messages: [
          person,
          asked("ask", "ask_person", { question: "Which account?" }),
          result("ask", "Put to the person in this conversation."),
        ],
        running: false,
      }),
    ).toBe(false);
  });

  test("an empty conversation, or one ending on the person's words, is not unfinished", () => {
    expect(unfinishedTurn({ messages: [], running: false })).toBe(false);
    expect(unfinishedTurn({ messages: [person], running: false })).toBe(false);
  });
});

describe("whether this turn used the browser", () => {
  test("a browsing step since the turn began counts; a command or an older step does not", () => {
    const bot = `watch-bot-${Math.random()}`;
    try {
      const before = Date.now();
      recordActivity(bot, { kind: "command", subject: "ls", output: "" });
      expect(browsedSince(bot, before)).toBe(false);
      recordActivity(bot, { kind: "page", subject: "gov.gr", output: "" });
      expect(browsedSince(bot, before)).toBe(true);
      expect(browsedSince(bot, Date.now() + 1000)).toBe(false);
    } finally {
      clearActivity(bot);
    }
  });
});
