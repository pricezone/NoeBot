import { describe, expect, test } from "bun:test";
import { parseOptions, summarizeTurn, TASKS, table } from "./bench-browser";

describe("bench:browser", () => {
  test("without a target it is a dry run of every task", () => {
    const options = parseOptions([], {});
    expect(options.dryRun).toBe(true);
    expect(options.tasks.map((task) => task.id)).toEqual(
      TASKS.map((task) => task.id),
    );
  });

  test("a target and a session make it live, narrowed to the tasks asked for", () => {
    const options = parseOptions(["--tasks=iframe,dropdown", "--timeout=30"], {
      BASE_URL: "https://bot.example/",
      STORAGE_STATE: "state.json",
    });
    expect(options.dryRun).toBe(false);
    expect(options.baseUrl).toBe("https://bot.example");
    expect(options.timeoutMs).toBe(30_000);
    expect(options.tasks.map((task) => task.id)).toEqual([
      "dropdown",
      "iframe",
    ]);
    expect(() => parseOptions(["--tasks=nope"], {})).toThrow("Unknown task");
  });

  test("a turn is summarized from the last user message: its tools and its final words", () => {
    const summary = summarizeTurn([
      { role: "user", content: "earlier" },
      { role: "assistant", toolCalls: [{ name: "computer_navigate" }] },
      { role: "user", content: "now" },
      { role: "assistant", toolCalls: [{ name: "computer_navigate" }] },
      { role: "tool", content: "{}" },
      {
        role: "assistant",
        toolCalls: [{ function: { name: "computer_click" } }],
      },
      { role: "tool", content: "{}" },
      { role: "assistant", content: "Option 2 is selected." },
    ]);
    expect(summary).toEqual({
      tools: ["computer_navigate", "computer_click"],
      answer: "Option 2 is selected.",
      finished: true,
    });
    expect(
      summarizeTurn([
        { role: "user", content: "now" },
        { role: "assistant", toolCalls: [{ name: "computer_click" }] },
      ]).finished,
    ).toBe(false);
  });

  test("the table has one row per task", () => {
    const text = table([
      {
        task: "dropdown",
        ok: true,
        wallMs: 12_300,
        toolCalls: 4,
        tools: [],
        answer: "Option 2",
      },
    ]);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("12.3s");
  });
});
