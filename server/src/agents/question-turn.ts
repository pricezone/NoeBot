import {
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";
import { isStandIn, QUESTION_TOOLS } from "../../../shared/question-tools";
import { questionWasPut, unwrapped } from "./asked-question";
import { ESCALATE_TOOL } from "./escalation";
import type { PlanLanguageModel } from "./plan-model";

/**
 * A question to the person ends the Bot's turn, and the person's next message is read as its answer.
 *
 * Both halves live where the runtime hands a prompt to the provider, because that is the only place
 * that sees every step of a run, the steps a run takes on its own included, and the only place a
 * change reaches the model without reaching the stored transcript.
 *
 * 1. ENDING THE TURN. `ask_person` was an ordinary tool: after its result the built-in agent was
 *    given another step, and a model handed its own question back with nobody answering it answered
 *    it itself ("Great choice. For research and writing…"). The runtime offers no stop condition
 *    beyond a step count, so the step after a question that reached somebody is answered here, with
 *    an empty finish, and the provider is never called. The turn ends cleanly with the question
 *    waiting, for every initiator. A responsibility's question never gets this far: it suspends its
 *    run before a result exists (`index.ts`), and its answer comes back as that result, which does
 *    not start with `PUT_TO`.
 * 2. READING THE ANSWER. A message that follows an open question is the answer to it, even with the
 *    Bot's own words in between, which is the rule the conversation screen draws answered cards by
 *    (`app/src/lib/copilot/question-answers.ts`). The model is told so in a note in front of the
 *    message; the stored message is not touched.
 */

type Options = Parameters<PlanLanguageModel["doStream"]>[0];
type StreamResult = Awaited<ReturnType<PlanLanguageModel["doStream"]>>;
type GenerateResult = Awaited<ReturnType<PlanLanguageModel["doGenerate"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;
type Prompt = Options["prompt"];
type PromptMessage = Prompt[number];
type UserMessage = Extract<PromptMessage, { role: "user" }>;

/** A tool result's value, from the text or JSON output a prompt carries it in. */
function outputValue(output: unknown): unknown {
  if (!output || typeof output !== "object" || !("value" in output))
    return undefined;
  return output.value;
}

/**
 * Whether this prompt ends on a question that was put to somebody: the tool results after the last
 * thing the model said include an `ask_person` that reached them. Nothing more is for the model to
 * say until they answer.
 */
export function endsOnQuestion(prompt: Prompt): boolean {
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index];
    if (message?.role !== "tool") return false;
    for (const part of message.content)
      if (
        part.type === "tool-result" &&
        part.toolName === ESCALATE_TOOL &&
        questionWasPut(outputValue(part.output))
      )
        return true;
  }
  return false;
}

/** The words a question tool asked: `ask_person`'s question, or a decision card's title. */
function questionOf(input: unknown): string {
  let args = input;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return "";
    }
  }
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const words = record.question ?? record.title;
  return typeof words === "string" ? words.trim() : "";
}

/** The runtime's result for a frontend tool still being carried out: not an answer. */
function isForwardedPlaceholder(value: unknown): boolean {
  const text = unwrapped(value);
  return typeof text === "string" && text.trim() === "Forwarded to client";
}

/** A user message's words, from its text parts. */
function wordsOf(message: UserMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .trim();
}

/** How the note starts, so a message already carrying one is not noted twice. */
const NOTE_START = "[Answer to your question";
/** How an answer from the Approvals inbox already starts (`approvals/questions.ts`). */
const ALREADY_SAID = "In response to your question:";

/** The note in front of an answer: which question it answers, in the question's own words. */
export function answerNote(questions: readonly string[]): string {
  const asked = questions.filter((question) => question !== "");
  if (asked.length === 0) return `${NOTE_START}] `;
  const quoted = asked.map((question) => `“${question}”`).join(", ");
  return `${NOTE_START}${asked.length > 1 ? "s" : ""}: ${quoted}] `;
}

/** The message with the note in front of its first words. */
function noted(message: UserMessage, note: string): UserMessage {
  let placed = false;
  return {
    ...message,
    content: message.content.map((part) => {
      if (placed || part.type !== "text" || !part.text.trim()) return part;
      placed = true;
      return { ...part, text: `${note}${part.text}` };
    }),
  };
}

/**
 * The prompt with each answer to a question noted as one, for the model only.
 *
 * The open-question rule of `question-answers.ts`: every question tool's call opens a question; a
 * decision card's real result closes it (answered on the card, so the next message is not its
 * answer), and a stand-in or the runtime's placeholder does not; the first user message with words
 * after it answers every question still open. Returns the same array when nothing is noted, and the
 * same note for the same history on every request, so the provider's prompt cache still holds.
 */
export function noteAnswers(prompt: Prompt): Prompt {
  let open: { id: string; question: string }[] = [];
  const decisions = new Set<string>();
  let changed = false;
  const marked = prompt.map((message): PromptMessage => {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "tool-call" || !QUESTION_TOOLS.has(part.toolName))
          continue;
        open.push({ id: part.toolCallId, question: questionOf(part.input) });
        if (part.toolName !== ESCALATE_TOOL) decisions.add(part.toolCallId);
      }
      return message;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result" || !decisions.has(part.toolCallId))
          continue;
        const value = unwrapped(outputValue(part.output));
        if (!isStandIn(value) && !isForwardedPlaceholder(value))
          open = open.filter((waiting) => waiting.id !== part.toolCallId);
      }
      return message;
    }
    if (message.role !== "user" || open.length === 0) return message;
    const words = wordsOf(message);
    if (!words) return message;
    const questions = open.map((waiting) => waiting.question);
    open = [];
    if (words.startsWith(NOTE_START) || words.startsWith(ALREADY_SAID))
      return message;
    changed = true;
    return noted(message, answerNote(questions));
  });
  return changed ? marked : prompt;
}

const STOPPED: GenerateResult["finishReason"] = {
  unified: "stop",
  raw: undefined,
};
const NO_USAGE: GenerateResult["usage"] = {
  inputTokens: {
    total: 0,
    noCache: 0,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

class QuestionTurnModel implements PlanLanguageModel {
  readonly specificationVersion = "v3";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: PlanLanguageModel["supportedUrls"];

  constructor(private readonly inner: PlanLanguageModel) {
    this.provider = inner.provider;
    this.modelId = inner.modelId;
    this.supportedUrls = inner.supportedUrls;
  }

  async doGenerate(options: Options): Promise<GenerateResult> {
    if (endsOnQuestion(options.prompt))
      return {
        content: [],
        finishReason: STOPPED,
        usage: NO_USAGE,
        warnings: [],
      };
    return this.inner.doGenerate({
      ...options,
      prompt: noteAnswers(options.prompt),
    });
  }

  async doStream(options: Options): Promise<StreamResult> {
    if (endsOnQuestion(options.prompt))
      return {
        stream: new ReadableStream<Part>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "finish",
              finishReason: STOPPED,
              usage: NO_USAGE,
            });
            controller.close();
          },
        }),
      };
    return this.inner.doStream({
      ...options,
      prompt: noteAnswers(options.prompt),
    });
  }
}

/**
 * The configuration with its model answering for questions, whatever model it is: a provider model
 * (already tuned or still a spec to resolve) or a plan's. A factory configuration, and a spec that
 * will not resolve here, are returned as they are, to fail in the run exactly as before.
 */
export function questionTurns(
  configuration: BuiltInAgentConfiguration,
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  let model: unknown = configuration.model;
  if (typeof model === "string") {
    try {
      model = resolveModel(model, configuration.apiKey);
    } catch {
      return configuration;
    }
  }
  if (
    !model ||
    typeof model !== "object" ||
    (model as { specificationVersion?: unknown }).specificationVersion !== "v3"
  )
    return configuration;
  return {
    ...configuration,
    model: new QuestionTurnModel(model as PlanLanguageModel),
  };
}
