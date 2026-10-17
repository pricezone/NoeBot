import {
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";
import { isFirstTurn } from "../../../shared/first-turn";
import { isStandIn, QUESTION_TOOLS } from "../../../shared/question-tools";
import { readResponsibilityTurn } from "../../../shared/responsibility-turn";
import { readFiring } from "../../../shared/routine-firing";
import type { AuditInitiator } from "../audit";
import { questionWasPut, unwrapped } from "./asked-question";
import { ESCALATE_TOOL } from "./escalation";
import { currentModelRun } from "./model-tuning";
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
/**
 * The heading `groupTurnMessage` (`channels/group.ts`) puts above a group's shared transcript, whose
 * words are other participants', quoted. Restated rather than imported, so this module does not take
 * the group store along; `question-turn.test.ts` holds the two in step.
 */
export const GROUP_TRANSCRIPT_HEADING = "Shared group transcript (quoted";

/**
 * Whether a user message is something the person said, rather than a frame the deployment sent as
 * the user: a routine firing, a responsibility turn, a new Bot's first-turn frame, or a group turn
 * carrying other participants' words. Only the person's own words answer their question.
 */
function isPersonsOwn(words: string): boolean {
  return (
    readFiring(words) === null &&
    readResponsibilityTurn(words) === null &&
    !isFirstTurn(words) &&
    !words.includes(GROUP_TRANSCRIPT_HEADING)
  );
}

/**
 * Whether a run's answers may be noted at all: only a turn the person started. A routine, a
 * responsibility, a hop from another Bot or a memory sweep sends its own instruction as the user
 * message, and that is nobody's answer. No initiator is a person's request, as everywhere else.
 */
export function personStarted(initiator: AuditInitiator | undefined): boolean {
  return initiator === undefined || initiator.kind === "person";
}

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
 * Whether a question tool's result leaves its question waiting on the person.
 *
 * `ask_person` waits only while its result says it was put to them: a refusal, a question held for
 * the owner's permission, or a responsibility's question resumed with its answer ("The person
 * answered: …") is not waiting, and a message after it is not its answer. A decision card waits
 * until its real result arrives: a stand-in or the runtime's placeholder is not one.
 */
function stillWaits(tool: string, value: unknown): boolean {
  if (tool === ESCALATE_TOOL) return questionWasPut(value);
  return isStandIn(value) || isForwardedPlaceholder(value);
}

/**
 * The prompt with each answer to a question noted as one, for the model only.
 *
 * The open-question rule of `question-answers.ts`, tightened for what the model is told: a question
 * tool's call opens a question; a result that does not leave it waiting closes it
 * ({@link stillWaits}); the person's next message with words answers every question still open. A
 * frame the deployment sent as the user ({@link isPersonsOwn}) neither answers nor closes one.
 * Returns the same array when nothing is noted, and the same note for the same history on every
 * request, so the provider's prompt cache still holds. The caller decides whether the run is the
 * person's at all ({@link personStarted}).
 */
export function noteAnswers(prompt: Prompt): Prompt {
  let open: { id: string; question: string }[] = [];
  const tools = new Map<string, string>();
  let changed = false;
  const marked = prompt.map((message): PromptMessage => {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "tool-call" || !QUESTION_TOOLS.has(part.toolName))
          continue;
        open.push({ id: part.toolCallId, question: questionOf(part.input) });
        tools.set(part.toolCallId, part.toolName);
      }
      return message;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const tool = tools.get(part.toolCallId);
        if (tool && !stillWaits(tool, unwrapped(outputValue(part.output))))
          open = open.filter((waiting) => waiting.id !== part.toolCallId);
      }
      return message;
    }
    if (message.role !== "user" || open.length === 0) return message;
    const words = wordsOf(message);
    if (!words || !isPersonsOwn(words)) return message;
    const questions = open.map((waiting) => waiting.question);
    open = [];
    if (words.startsWith(NOTE_START) || words.startsWith(ALREADY_SAID))
      return message;
    changed = true;
    return noted(message, answerNote(questions));
  });
  return changed ? marked : prompt;
}

/** The prompt as this run's model should read it: answers noted only in a turn the person began. */
function preparedPrompt(prompt: Prompt): Prompt {
  return personStarted(currentModelRun()?.initiator)
    ? noteAnswers(prompt)
    : prompt;
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
      prompt: preparedPrompt(options.prompt),
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
      prompt: preparedPrompt(options.prompt),
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
