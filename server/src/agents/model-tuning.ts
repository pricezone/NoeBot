import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";
import type { AuditInitiator } from "../audit";
import { now, recordPhase } from "../run-timing";
import type { PlanLanguageModel } from "./plan-model";

/**
 * What the built-in Bot's model is asked, tuned for speed without changing what it is told.
 *
 * Three things, all at the boundary where the runtime hands a prompt to the provider, because that
 * is the only place that sees every step of a run, including the steps a single run takes on its own:
 *
 * 1. A prompt cache key per conversation (OpenAI `promptCacheKey`), so the long stable prefix
 *    (system prompt, tools, older turns) is served from the provider's cache step after step.
 * 2. Old page observations collapsed to a one-line stub before the model sees them. A browser turn
 *    carries a snapshot or page text per step, and all but the latest few are stale the moment the
 *    page changes. The stored transcript is not touched; only what this request sends.
 * 3. The reasoning effort, from BOT_REASONING_EFFORT, applied as a provider option.
 *
 * Timing is measured here too (time to first token, whole generation), for the per-run line.
 */

type Options = Parameters<PlanLanguageModel["doStream"]>[0];
type StreamResult = Awaited<ReturnType<PlanLanguageModel["doStream"]>>;
type GenerateResult = Awaited<ReturnType<PlanLanguageModel["doGenerate"]>>;
type Prompt = Options["prompt"];
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * The effort the built-in Bot reasons with when BOT_REASONING_EFFORT does not say.
 *
 * "low" because a browser turn is many short decisions (which ref, which field) where latency per
 * step dominates, and the default ("medium") spent seconds of hidden reasoning on each click. The
 * browser benchmark (`bun run bench:browser`) is what confirms or overturns this; set
 * BOT_REASONING_EFFORT=medium to go back without a release.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

/** BOT_REASONING_EFFORT, refused rather than guessed when it is not one of the four. */
export function reasoningEffortFrom(
  environment: Record<string, string | undefined>,
): ReasoningEffort {
  const raw = environment.BOT_REASONING_EFFORT?.trim().toLowerCase();
  if (!raw) return DEFAULT_REASONING_EFFORT;
  if ((REASONING_EFFORTS as readonly string[]).includes(raw))
    return raw as ReasoningEffort;
  throw new Error(
    `BOT_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}.`,
  );
}

/**
 * The conversation a model call belongs to, set around a run's subscription. `initiator` is what
 * started the run, absent for a person's request (`question-turn.ts` notes answers only then).
 */
export type ModelRun = {
  botId: string;
  threadId: string;
  runId: string;
  initiator?: AuditInitiator;
};
const modelRuns = new AsyncLocalStorage<ModelRun>();
export const withModelRun = <T>(run: ModelRun, work: () => T): T =>
  modelRuns.run(run, work);
export const currentModelRun = () => modelRuns.getStore();

/** Stable per Bot and conversation, short, and not the raw ids. */
export function promptCacheKey(botId: string, threadId: string): string {
  return `openbot-${createHash("sha256")
    .update(JSON.stringify([botId, threadId]))
    .digest("hex")
    .slice(0, 32)}`;
}

/** Tool results that describe a page, and so go stale as soon as the page changes. */
const OBSERVATION_TOOLS = new Set([
  "computer_snapshot",
  "computer_read",
  "computer_navigate",
]);
/** How many of the newest observations always stay whole. */
export const OBSERVATIONS_KEPT = 2;
/**
 * Observations are collapsed in blocks this size, so the prompt prefix changes once per block rather
 * than on every step, which is what keeps the provider's prompt cache warm.
 */
export const OBSERVATION_BLOCK = 10;

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Whether a tool result is a page observation: by tool name, or by carrying `page.elements`. */
function isObservation(toolName: string, value: unknown): boolean {
  if (OBSERVATION_TOOLS.has(toolName)) return true;
  const result = parsed(value);
  return (
    isRecord(result) &&
    isRecord(result.page) &&
    Array.isArray(result.page.elements)
  );
}

/** The one line an old observation becomes. Keeps where it was, never the refs or the text. */
export function observationStub(toolName: string, value: unknown): string {
  const result = parsed(value);
  const kept: Record<string, unknown> = {};
  if (isRecord(result)) {
    for (const key of ["ok", "url", "title"] as const) {
      const field = result[key];
      if (
        typeof field === "boolean" ||
        (typeof field === "string" && field.length <= 300)
      )
        kept[key] = field;
    }
    const page = result.page;
    if (isRecord(page))
      for (const key of ["url", "title"] as const) {
        const field = page[key];
        if (typeof field === "string" && field.length <= 300 && !(key in kept))
          kept[key] = field;
      }
  }
  return JSON.stringify({
    ...kept,
    omitted: `An older ${toolName} result, left out to keep this conversation short. Its refs are stale: take a fresh snapshot or read the page for the current state.`,
  });
}

/**
 * The prompt with every page observation but the newest few collapsed to a stub.
 *
 * Collapsed in whole blocks of {@link OBSERVATION_BLOCK}: with N observations, the oldest
 * floor((N - kept) / block) * block are stubbed, so between two boundaries the request only grows at
 * the end and its prefix is byte-for-byte the one the provider cached. Returns the same array when
 * nothing changes.
 */
export function trimStaleObservations(prompt: Prompt): Prompt {
  const positions: { message: number; part: number }[] = [];
  prompt.forEach((message, messageIndex) => {
    if (message.role !== "tool") return;
    message.content.forEach((part, partIndex) => {
      if (part.type !== "tool-result") return;
      const output = part.output;
      const value =
        output.type === "text" || output.type === "json"
          ? output.value
          : undefined;
      if (value !== undefined && isObservation(part.toolName, value))
        positions.push({ message: messageIndex, part: partIndex });
    });
  });
  const collapse =
    Math.floor(
      Math.max(0, positions.length - OBSERVATIONS_KEPT) / OBSERVATION_BLOCK,
    ) * OBSERVATION_BLOCK;
  if (collapse === 0) return prompt;
  const stubbed = new Map<number, Set<number>>();
  for (const position of positions.slice(0, collapse)) {
    const parts = stubbed.get(position.message) ?? new Set<number>();
    parts.add(position.part);
    stubbed.set(position.message, parts);
  }
  return prompt.map((message, messageIndex) => {
    const parts = stubbed.get(messageIndex);
    if (!parts || message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part, partIndex) => {
        if (!parts.has(partIndex) || part.type !== "tool-result") return part;
        const output = part.output;
        const value =
          output.type === "text" || output.type === "json"
            ? output.value
            : undefined;
        return {
          ...part,
          output: {
            type: "text" as const,
            value: observationStub(part.toolName, value),
          },
        };
      }),
    };
  }) as Prompt;
}

/** Parts that mean the model has started answering. */
const FIRST_TOKEN = new Set<Part["type"]>([
  "text-delta",
  "reasoning-start",
  "tool-input-start",
  "tool-call",
]);

class TunedModel implements PlanLanguageModel {
  readonly specificationVersion = "v3";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: PlanLanguageModel["supportedUrls"];

  constructor(
    private readonly inner: PlanLanguageModel,
    private readonly openai: boolean,
  ) {
    this.provider = inner.provider;
    this.modelId = inner.modelId;
    this.supportedUrls = inner.supportedUrls;
  }

  private tune(options: Options): Options {
    const run = currentModelRun();
    const prompt = trimStaleObservations(options.prompt);
    if (!this.openai || !run) return { ...options, prompt };
    const openaiOptions = options.providerOptions?.openai ?? {};
    return {
      ...options,
      prompt,
      providerOptions: {
        ...options.providerOptions,
        openai: {
          ...openaiOptions,
          promptCacheKey: promptCacheKey(run.botId, run.threadId),
        },
      },
    };
  }

  async doGenerate(options: Options): Promise<GenerateResult> {
    const threadId = currentModelRun()?.threadId;
    const started = now();
    try {
      return await this.inner.doGenerate(this.tune(options));
    } finally {
      recordPhase("model.generate", now() - started, threadId);
    }
  }

  async doStream(options: Options): Promise<StreamResult> {
    const threadId = currentModelRun()?.threadId;
    const started = now();
    const result = await this.inner.doStream(this.tune(options));
    let first = true;
    const timing = new TransformStream<Part, Part>({
      transform(part, controller) {
        if (first && FIRST_TOKEN.has(part.type)) {
          first = false;
          recordPhase("model.ttft", now() - started, threadId);
        }
        if (part.type === "finish")
          recordPhase("model.total", now() - started, threadId);
        controller.enqueue(part);
      },
    });
    return { ...result, stream: result.stream.pipeThrough(timing) };
  }
}

/**
 * The configuration with its model wrapped and its reasoning effort set.
 *
 * A factory configuration (the failing one for a missing credential) and a plan model are returned
 * as they are: neither talks to a provider this deployment configures. A model spec that will not
 * resolve here is left as the string, so it fails in the run exactly as it did before.
 */
export function tunedConfiguration(
  configuration: BuiltInAgentConfiguration,
  options: {
    provider: "openai" | "anthropic";
    reasoningEffort?: ReasoningEffort;
  },
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  const spec = configuration.model;
  if (typeof spec !== "string") return configuration;
  let resolved: unknown;
  try {
    resolved = resolveModel(spec, configuration.apiKey);
  } catch {
    return configuration;
  }
  if (
    !resolved ||
    typeof resolved !== "object" ||
    (resolved as { specificationVersion?: unknown }).specificationVersion !==
      "v3"
  )
    return configuration;
  const openai = options.provider === "openai";
  return {
    ...configuration,
    model: new TunedModel(resolved as PlanLanguageModel, openai),
    ...(openai && options.reasoningEffort
      ? {
          providerOptions: {
            ...configuration.providerOptions,
            openai: {
              ...configuration.providerOptions?.openai,
              reasoningEffort: options.reasoningEffort,
            },
          },
        }
      : {}),
  };
}
