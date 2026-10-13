import { afterEach, describe, expect, test } from "bun:test";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import {
  DEFAULT_REASONING_EFFORT,
  OBSERVATION_BLOCK,
  OBSERVATIONS_KEPT,
  observationStub,
  promptCacheKey,
  reasoningEffortFrom,
  trimStaleObservations,
  tunedConfiguration,
  withModelRun,
} from "../src/agents/model-tuning";
import type { PlanLanguageModel } from "../src/agents/plan-model";
import { OPEN_PAGE_NOTE, withOpenPageNote } from "../src/copilot";
import {
  beginRunTiming,
  endRunTiming,
  resetRunTimingForTests,
} from "../src/run-timing";

type Options = Parameters<PlanLanguageModel["doStream"]>[0];
type Prompt = Options["prompt"];

afterEach(resetRunTimingForTests);

/** A prompt of `count` browser steps: a call and its result each, with page text in the result. */
function browsing(count: number, tool = "computer_snapshot"): Prompt {
  const prompt: Prompt = [
    { role: "system", content: "Be helpful." },
    { role: "user", content: [{ type: "text", text: "Do the thing." }] },
  ];
  for (let step = 1; step <= count; step++) {
    prompt.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${step}`,
          toolName: tool,
          input: {},
        },
      ],
    });
    prompt.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${step}`,
          toolName: tool,
          output: {
            type: "text",
            value: JSON.stringify({
              ok: true,
              url: `https://example.com/${step}`,
              snapshotId: step,
              elements: [{ ref: "e1", name: `Step ${step}` }],
            }),
          },
        },
      ],
    });
  }
  return prompt;
}

function resultValues(prompt: Prompt): string[] {
  return prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" && part.output.type === "text"
            ? [part.output.value]
            : [],
        )
      : [],
  );
}

describe("old page observations", () => {
  test("nothing is collapsed until a whole block is stale, so the prefix stays cached", () => {
    const prompt = browsing(OBSERVATIONS_KEPT + OBSERVATION_BLOCK - 1);
    expect(trimStaleObservations(prompt)).toBe(prompt);
  });

  test("a block at a time is collapsed, oldest first, and the newest stay whole", () => {
    const count = OBSERVATIONS_KEPT + OBSERVATION_BLOCK + 3;
    const values = resultValues(trimStaleObservations(browsing(count)));
    expect(values).toHaveLength(count);
    const collapsed = values.filter((value) => value.includes("omitted"));
    expect(collapsed).toHaveLength(OBSERVATION_BLOCK);
    expect(values.slice(0, OBSERVATION_BLOCK)).toEqual(collapsed);
    for (const value of values.slice(OBSERVATION_BLOCK))
      expect(value).toContain('"elements"');
  });

  test("the prefix is byte-identical between two block boundaries", () => {
    const at = OBSERVATIONS_KEPT + OBSERVATION_BLOCK;
    const earlier = trimStaleObservations(browsing(at));
    const later = trimStaleObservations(browsing(at + 5));
    expect(JSON.stringify(later.slice(0, earlier.length))).toBe(
      JSON.stringify(earlier),
    );
  });

  test("any result carrying page.elements counts, whatever the tool", () => {
    const prompt = browsing(
      OBSERVATIONS_KEPT + OBSERVATION_BLOCK,
      "computer_click",
    ).map((message) =>
      message.role === "tool"
        ? {
            ...message,
            content: message.content.map((part) =>
              part.type === "tool-result"
                ? {
                    ...part,
                    output: {
                      type: "text" as const,
                      value: JSON.stringify({
                        ok: true,
                        element: { name: "Save" },
                        page: {
                          url: "https://example.com/form",
                          elements: [{ ref: "e9" }],
                        },
                      }),
                    },
                  }
                : part,
            ),
          }
        : message,
    ) as Prompt;
    const collapsed = resultValues(trimStaleObservations(prompt)).filter(
      (value) => value.includes("omitted"),
    );
    expect(collapsed).toHaveLength(OBSERVATION_BLOCK);
    expect(JSON.parse(collapsed[0] ?? "{}")).toMatchObject({
      ok: true,
      url: "https://example.com/form",
    });
  });

  test("other tools' results are never touched", () => {
    const prompt = browsing(30, "computer_run_command");
    expect(trimStaleObservations(prompt)).toBe(prompt);
  });

  test("a stub keeps where the page was and never its refs or text", () => {
    const stub = JSON.parse(
      observationStub(
        "computer_navigate",
        JSON.stringify({
          ok: true,
          url: "https://example.com",
          title: "Example",
          text: "secret page text",
          snapshotId: 4,
        }),
      ),
    );
    expect(stub).toMatchObject({
      ok: true,
      url: "https://example.com",
      title: "Example",
    });
    expect(stub.text).toBeUndefined();
    expect(stub.snapshotId).toBeUndefined();
  });
});

describe("reasoning effort", () => {
  test("defaults to low and refuses anything that is not an effort", () => {
    expect(DEFAULT_REASONING_EFFORT).toBe("low");
    expect(reasoningEffortFrom({})).toBe("low");
    expect(reasoningEffortFrom({ BOT_REASONING_EFFORT: " High " })).toBe(
      "high",
    );
    expect(() => reasoningEffortFrom({ BOT_REASONING_EFFORT: "max" })).toThrow(
      "BOT_REASONING_EFFORT",
    );
  });
});

/** A provider model that records what it was asked and streams two words. */
function recordingModel() {
  const calls: Options[] = [];
  const model: PlanLanguageModel = {
    specificationVersion: "v3",
    provider: "openai.responses",
    modelId: "gpt-test",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("not used");
    },
    doStream: async (options) => {
      calls.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "hi" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      } as Awaited<ReturnType<PlanLanguageModel["doStream"]>>;
    },
  };
  return { calls, model };
}

describe("the tuned model", () => {
  test("sets the reasoning effort and wraps the model; leaves a failing factory alone", () => {
    const configuration: BuiltInAgentConfiguration = {
      model: "openai/gpt-5.5",
      apiKey: "sk-test",
      prompt: "Be helpful.",
    };
    const tuned = tunedConfiguration(configuration, {
      provider: "openai",
      reasoningEffort: "low",
    });
    expect("factory" in tuned).toBe(false);
    if ("factory" in tuned) return;
    expect(typeof tuned.model).toBe("object");
    expect(tuned.providerOptions).toEqual({
      openai: { reasoningEffort: "low" },
    });
    const factory: BuiltInAgentConfiguration = {
      type: "custom",
      // biome-ignore lint/correctness/useYield: a factory that fails when iterated.
      factory: async function* () {
        throw new Error("no key");
      },
    };
    expect(tunedConfiguration(factory, { provider: "openai" })).toBe(factory);
  });

  test("asks the provider with a per-conversation cache key, trimmed, and times the call", async () => {
    const { calls, model } = recordingModel();
    const tuned = tunedConfiguration(
      { model: "openai/gpt-5.5", apiKey: "sk-test", prompt: "x" },
      { provider: "openai" },
    );
    if ("factory" in tuned || typeof tuned.model !== "object")
      throw new Error("expected a model");
    // Swap the resolved provider model for the recording one, keeping the wrapper.
    (tuned.model as unknown as { inner: PlanLanguageModel }).inner = model;
    const timing = beginRunTiming("thread-1", "run-1");
    const result = await withModelRun(
      { botId: "bot", threadId: "thread-1", runId: "run-1" },
      () =>
        (tuned.model as PlanLanguageModel).doStream({
          prompt: browsing(OBSERVATIONS_KEPT + OBSERVATION_BLOCK),
        } as Options),
    );
    const reader = result.stream.getReader();
    while (!(await reader.read()).done) {}
    expect(calls[0]?.providerOptions).toEqual({
      openai: { promptCacheKey: promptCacheKey("bot", "thread-1") },
    });
    expect(
      resultValues(calls[0]?.prompt ?? []).filter((value) =>
        value.includes("omitted"),
      ),
    ).toHaveLength(OBSERVATION_BLOCK);
    const lines: string[] = [];
    endRunTiming(timing, (line) => lines.push(line));
    expect(lines[0]).toMatch(/model\.ttft:\d+,model\.total:\d+/);
  });

  test("the cache key is stable per Bot and conversation and names neither", () => {
    expect(promptCacheKey("bot", "thread")).toBe(
      promptCacheKey("bot", "thread"),
    );
    expect(promptCacheKey("bot", "thread")).not.toBe(
      promptCacheKey("bot", "other"),
    );
    expect(promptCacheKey("bot", "thread")).not.toContain("thread");
  });
});

describe("generated-interface tools", () => {
  test("say once that they are not for showing an open web page", () => {
    const tools = [
      {
        name: "render_a2ui",
        description: "Draw an interface.",
        parameters: {},
      },
      { name: "generateSandboxedUi", description: "Write UI.", parameters: {} },
      { name: "computer_click", description: "Click.", parameters: {} },
    ];
    const noted = withOpenPageNote(tools);
    expect(noted[0]?.description).toBe(`Draw an interface. ${OPEN_PAGE_NOTE}`);
    expect(noted[1]?.description).toContain(OPEN_PAGE_NOTE);
    expect(noted[2]).toBe(tools[2]);
    expect(withOpenPageNote(noted)[0]?.description).toBe(noted[0]?.description);
  });
});
