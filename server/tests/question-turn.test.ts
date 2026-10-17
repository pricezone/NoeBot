import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
} from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { frameFirstTurn } from "../../shared/first-turn";
import { PUT_TO } from "../../shared/handoff-markers";
import { ANSWERED_IN_CHAT } from "../../shared/question-tools";
import { buildResponsibilityTurn } from "../../shared/responsibility-turn";
import { frameFiring } from "../../shared/routine-firing";
import {
  endsOnAskedQuestion,
  sayingTheQuestion,
} from "../src/agents/asked-question";
import { askTheirOwnPerson, escalationTool } from "../src/agents/escalation";
import {
  answerNote,
  endsOnQuestion,
  noteAnswers,
  personStarted,
} from "../src/agents/question-turn";
import type { AuditInitiator } from "../src/audit";
import { groupTurnMessage } from "../src/channels/group";
import type { HeadlessTool } from "../src/computer/headless-tools";
import { buildAgents, type ComputerInRun } from "../src/copilot";

/**
 * A question to the person ends the Bot's turn, and the person's reply is read as its answer.
 *
 * Found on a new Bot's first turn: the Bot asked "What do you mainly want help with?" and then, given
 * another step with nobody answering, answered it itself. These hold the run to one model call once
 * a question is put, whoever started the run, with the transcript intact; and the reply that follows,
 * with or without the Bot's words in between, reaching the model as the answer it is.
 */

type Prompt = Parameters<typeof endsOnQuestion>[0];

const QUESTION = "What do you mainly want help with?";
const OPTIONS = ["Research and writing", "Code and GitHub work"];
const PUT = `${PUT_TO}the person in this conversation. They can see the question.`;

const call = (id: string, toolName: string, input: unknown) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName,
  input,
});
const result = (id: string, toolName: string, value: unknown) => ({
  role: "tool" as const,
  content: [
    {
      type: "tool-result" as const,
      toolCallId: id,
      toolName,
      output: { type: "text" as const, value: String(value) },
    },
  ],
});
const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});
const said = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});

describe("a prompt that ends on a question", () => {
  test("is one whose last results include an ask_person that reached somebody", () => {
    const prompt: Prompt = [
      user("Hello"),
      {
        role: "assistant",
        content: [call("q1", "ask_person", { question: QUESTION })],
      },
      result("q1", "ask_person", PUT),
    ];
    expect(endsOnQuestion(prompt)).toBe(true);
  });

  test("reads the result stored JSON-encoded, as history carries it", () => {
    const prompt: Prompt = [
      user("Hello"),
      {
        role: "assistant",
        content: [call("q1", "ask_person", { question: QUESTION })],
      },
      result("q1", "ask_person", JSON.stringify(PUT)),
    ];
    expect(endsOnQuestion(prompt)).toBe(true);
  });

  test("ends on it whichever result came last in the step", () => {
    const prompt: Prompt = [
      user("Hello"),
      {
        role: "assistant",
        content: [
          call("q1", "ask_person", { question: QUESTION }),
          call("s1", "search", { query: "x" }),
        ],
      },
      result("q1", "ask_person", PUT),
      result("s1", "search", "found"),
    ];
    expect(endsOnQuestion(prompt)).toBe(true);
  });

  test("is not a question that was refused, so the Bot can say so", () => {
    const prompt: Prompt = [
      user("Hello"),
      {
        role: "assistant",
        content: [call("q1", "ask_person", { question: QUESTION })],
      },
      result("q1", "ask_person", "That did not reach anybody."),
    ];
    expect(endsOnQuestion(prompt)).toBe(false);
  });

  test("is not a responsibility's question resumed with its answer", () => {
    const prompt: Prompt = [
      user("Watch the build"),
      {
        role: "assistant",
        content: [call("q1", "ask_person", { question: "Deploy now?" })],
      },
      result("q1", "ask_person", "The person answered: yes"),
    ];
    expect(endsOnQuestion(prompt)).toBe(false);
  });

  test("is not one the person has already answered", () => {
    const prompt: Prompt = [
      {
        role: "assistant",
        content: [call("q1", "ask_person", { question: QUESTION })],
      },
      result("q1", "ask_person", PUT),
      user("Research and writing"),
    ];
    expect(endsOnQuestion(prompt)).toBe(false);
  });

  test("reads the same from a run's AG-UI messages", () => {
    const messages: Message[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "q1",
            type: "function",
            function: { name: "ask_person", arguments: "{}" },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "q1", content: PUT },
    ];
    expect(endsOnAskedQuestion(messages)).toBe(true);
    expect(
      endsOnAskedQuestion([
        ...messages,
        { id: "u1", role: "user", content: "Yes" },
      ]),
    ).toBe(false);
  });
});

describe("a reply to an open question", () => {
  const asked: Prompt = [
    user("Hello"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "Hi! I'm New Bot." },
        call("q1", "ask_person", { question: QUESTION, options: OPTIONS }),
      ],
    },
    result("q1", "ask_person", PUT),
  ];

  test("is noted as the answer, with the question in its own words", () => {
    const noted = noteAnswers([...asked, user("Research and writing")]);
    expect(noted.at(-1)).toEqual(
      user(`${answerNote([QUESTION])}Research and writing`),
    );
    expect(answerNote([QUESTION])).toBe(
      `[Answer to your question: “${QUESTION}”] `,
    );
  });

  test("is noted even with the Bot's words in between", () => {
    const noted = noteAnswers([
      ...asked,
      said("Take your time."),
      user("Code and GitHub work"),
    ]);
    expect(noted.at(-1)).toEqual(
      user(`${answerNote([QUESTION])}Code and GitHub work`),
    );
  });

  test("only the first reply is the answer", () => {
    const noted = noteAnswers([
      ...asked,
      user("Research and writing"),
      said("On it."),
      user("Thanks"),
    ]);
    expect(noted.at(-1)).toEqual(user("Thanks"));
  });

  test("a decision answered on its card is answered, so the next message is not", () => {
    const prompt: Prompt = [
      user("Ship it"),
      {
        role: "assistant",
        content: [call("c1", "askChoice", { title: "Where to?" })],
      },
      result("c1", "askChoice", JSON.stringify({ choice: "staging" })),
      user("And then lunch"),
    ];
    expect(noteAnswers(prompt)).toBe(prompt);
  });

  test("a decision with only a stand-in result is answered by the next message", () => {
    const prompt: Prompt = [
      user("Ship it"),
      {
        role: "assistant",
        content: [call("c1", "askChoice", { title: "Where to?" })],
      },
      result("c1", "askChoice", ANSWERED_IN_CHAT),
      user("Staging"),
    ];
    expect(noteAnswers(prompt).at(-1)).toEqual(
      user(`${answerNote(["Where to?"])}Staging`),
    );
  });

  test("leaves a prompt with nothing to note as it was, and never notes twice", () => {
    const plain: Prompt = [user("Hello"), said("Hi")];
    expect(noteAnswers(plain)).toBe(plain);
    const once = noteAnswers([...asked, user("Research and writing")]);
    expect(noteAnswers(once)).toEqual(once);
  });
});

describe("a question that is not waiting", () => {
  const BACKUPS = "Shall I delete the old backups?";
  const askedThen = (answer: string): Prompt => [
    user("Clean up the server"),
    {
      role: "assistant",
      content: [call("q1", "ask_person", { question: BACKUPS })],
    },
    result("q1", "ask_person", answer),
  ];

  test("held for the owner's permission, is not answered by the next message", () => {
    // The person never saw the question, so their "ok" consents to nothing.
    const prompt: Prompt = [
      ...askedThen(
        "That was not put to anybody yet: it needs your permission. Tell the person you are waiting for their permission in Approvals.",
      ),
      said("I'm waiting for your permission in Approvals."),
      user("ok"),
    ];
    expect(noteAnswers(prompt)).toBe(prompt);
  });

  test("refused, is not answered by the next message", () => {
    const prompt: Prompt = [
      ...askedThen(JSON.stringify("That did not reach anybody.")),
      user("ok"),
    ];
    expect(noteAnswers(prompt)).toBe(prompt);
  });

  test("already answered on resume, is not answered again by the next message", () => {
    const prompt: Prompt = [
      ...askedThen("The person answered: yes"),
      said("Deleted."),
      user("What's the status of the build?"),
    ];
    expect(noteAnswers(prompt)).toBe(prompt);
  });
});

describe("a message that is not the person's own words", () => {
  const INVOICE = "Shall I send the invoice to the client?";
  const open: Prompt = [
    user("Invoice ACME"),
    {
      role: "assistant",
      content: [call("q1", "ask_person", { question: INVOICE })],
    },
    result("q1", "ask_person", PUT),
  ];
  const groupText = (() => {
    const message = groupTurnMessage("g1", "yes", [
      { id: "m1", agentId: "bot_peer", text: "I can send it." },
    ]);
    return typeof message.content === "string" ? message.content : "";
  })();

  test.each([
    ["a routine firing", frameFiring("Send me the daily summary.")],
    [
      "a responsibility turn",
      buildResponsibilityTurn({
        instruction: "Watch the build",
        successCriteria: "Green",
        progress: "",
        trigger: { source: "github", type: "push" },
        eventData: "{}",
        responsibilityId: "resp_1",
      }),
    ],
    ["a new Bot's first-turn frame", frameFirstTurn()],
    ["a group turn quoting other participants", groupText],
  ])("%s is not an answer, and leaves the question open", (_kind, text) => {
    const prompt: Prompt = [...open, user(text), user("Yes, send it")];
    const noted = noteAnswers(prompt);
    expect(noted.at(-2)).toEqual(user(text));
    expect(noted.at(-1)).toEqual(user(`${answerNote([INVOICE])}Yes, send it`));
  });

  test("only a turn the person started has its answers noted", () => {
    expect(personStarted(undefined)).toBe(true);
    expect(personStarted({ kind: "person" })).toBe(true);
    for (const initiator of [
      { kind: "routine", id: "r1" },
      { kind: "responsibility", id: "x1" },
      { kind: "handoff", id: "bot_peer" },
      { kind: "memory", id: "m1" },
      { kind: "deployment" },
    ] as const)
      expect(personStarted(initiator)).toBe(false);
  });
});

describe("a group conversation's row", () => {
  test("says the question the Bot ended on, once", () => {
    expect(sayingTheQuestion("Two accounts match.", "Which one?")).toBe(
      "Two accounts match.\n\nWhich one?",
    );
    expect(sayingTheQuestion("", "Which one?")).toBe("Which one?");
    expect(sayingTheQuestion("Which one?", "Which one?")).toBe("Which one?");
    expect(sayingTheQuestion("Done.")).toBe("Done.");
  });
});

/* A built-in Bot, end to end, with a fake model. */

const llm = new LLMock();
let originalBase: string | undefined;
beforeAll(async () => {
  originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await llm.start();
});
afterAll(async () => {
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBase;
  await llm.stop();
});

const ANSWERED_ITSELF =
  "Great choice. For research and writing, call me Quill.";

/** Asks on the first call; anything after a tool result is the Bot answering its own question. */
function scriptAsking(first: { content?: string; toolCalls: unknown[] }) {
  llm.clearFixtures();
  llm.reset?.();
  llm.onMessage(/.*/, (request) => {
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { content: ANSWERED_ITSELF };
    return first as never;
  });
}

const ASK = {
  id: "call-ask",
  name: "ask_person",
  arguments: JSON.stringify({ question: QUESTION, options: OPTIONS }),
};

async function bot(computerInRun?: ComputerInRun, initiator?: AuditInitiator) {
  const agents = await buildAgents(
    [
      {
        id: "bot",
        name: "New Bot",
        type: "built_in",
        systemPrompt: "Help the person.",
      },
    ],
    { provider: "openai", defaultModel: "gpt-4.1-mini" },
    "synthetic-key",
    // stallGuard through agentFetch: seven positions this test does not need.
    ...Array.from({ length: 7 }, () => undefined),
    // The coordination tools, as a person's run gets them: here only asking the person.
    async (botId, input) => [
      escalationTool({
        from: {
          botId,
          actorId: "owner",
          runId: input.runId,
          threadId: input.threadId,
          depth: 0,
        },
        route: askTheirOwnPerson,
      }),
    ],
    // loadInstructions, then what started the run, then four more this test does not need.
    undefined,
    initiator,
    ...Array.from({ length: 4 }, () => undefined),
    computerInRun,
  );
  const agent = agents.bot?.clone();
  if (!agent) throw new Error("expected the Bot");
  return agent;
}

async function run(agent: AbstractAgent, tools: unknown[] = []) {
  const events: BaseEvent[] = [];
  await agent.runAgent(
    { tools: tools as never },
    { onEvent: ({ event }) => void events.push(event) },
  );
  return events;
}

const count = (events: BaseEvent[], type: EventType) =>
  events.filter((event) => event.type === type).length;

describe("a person's run that asks a question", () => {
  test("ends on the question: no further model call, and the transcript intact", async () => {
    scriptAsking({ content: "Hi! I'm New Bot.", toolCalls: [ASK] });
    const agent = await bot();
    agent.setMessages([{ id: "u1", role: "user", content: "Say hello." }]);
    const before = llm.getRequests().length;

    const events = await run(agent);

    expect(llm.getRequests().length - before).toBe(1);
    expect(count(events, EventType.RUN_ERROR)).toBe(0);
    expect(count(events, EventType.RUN_FINISHED)).toBe(1);
    expect(
      events.find((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject({ toolCallId: "call-ask" });

    const [, assistant, answer, ...after] = agent.messages;
    expect(assistant).toMatchObject({
      role: "assistant",
      content: "Hi! I'm New Bot.",
    });
    expect(
      assistant?.role === "assistant"
        ? assistant.toolCalls?.map((made) => made.function.name)
        : [],
    ).toEqual(["ask_person"]);
    expect(answer?.role).toBe("tool");
    expect(String(answer?.content)).toContain(PUT_TO);
    expect(after).toEqual([]);
    expect(JSON.stringify(agent.messages)).not.toContain(ANSWERED_ITSELF);
  });

  test("its reply reaches the model as the answer, and is stored as typed", async () => {
    llm.clearFixtures();
    llm.reset?.();
    llm.onMessage(/.*/, () => ({ content: "On it." }));
    const agent = await bot();
    agent.setMessages([
      { id: "u1", role: "user", content: "Say hello." },
      {
        id: "a1",
        role: "assistant",
        content: "Hi! I'm New Bot.",
        toolCalls: [
          {
            id: "call-ask",
            type: "function",
            function: { name: "ask_person", arguments: ASK.arguments },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "call-ask",
        content: JSON.stringify(PUT),
      },
      { id: "a2", role: "assistant", content: "Take your time." },
      { id: "u2", role: "user", content: "Research and writing" },
    ]);
    const before = llm.getRequests().length;

    await run(agent);

    expect(llm.getRequests().length - before).toBe(1);
    const sent = JSON.stringify(llm.getRequests().at(-1)?.body ?? {});
    expect(sent).toContain(
      JSON.stringify(`${answerNote([QUESTION])}Research and writing`).slice(
        1,
        -1,
      ),
    );
    expect(agent.messages.find((message) => message.id === "u2")).toEqual({
      id: "u2",
      role: "user",
      content: "Research and writing",
    });
  });

  test("a routine's run does not take its own instruction for the person's answer", async () => {
    llm.clearFixtures();
    llm.reset?.();
    llm.onMessage(/.*/, () => ({ content: "Here is the summary." }));
    const agent = await bot(undefined, { kind: "routine", id: "routine_1" });
    agent.setMessages([
      { id: "u1", role: "user", content: "Invoice ACME." },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-ask",
            type: "function",
            function: { name: "ask_person", arguments: ASK.arguments },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "call-ask", content: PUT },
      { id: "u2", role: "user", content: "Send me the daily summary." },
    ]);
    const before = llm.getRequests().length;

    await run(agent);

    expect(llm.getRequests().length - before).toBe(1);
    const sent = JSON.stringify(llm.getRequests().at(-1)?.body ?? {});
    expect(sent).toContain("Send me the daily summary.");
    expect(sent).not.toContain("[Answer to your question");
  });
});

describe("a computer run that asks a question", () => {
  const browserClick = {
    name: "computer_click",
    description: "Click.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  };

  test("ends on the question after a click, without being nudged or failed as silent", async () => {
    llm.clearFixtures();
    llm.reset?.();
    llm.onMessage(/.*/, (request) => {
      const seen = JSON.stringify(request.messages);
      // Given the question's own result back, the model would answer it.
      if (seen.includes(PUT_TO)) return { content: ANSWERED_ITSELF };
      if (!request.messages.some((message) => message.role === "tool"))
        return {
          toolCalls: [
            {
              id: "call-click",
              name: "computer_click",
              arguments: JSON.stringify({ ref: "e1" }),
            },
          ],
        };
      return {
        toolCalls: [
          {
            id: "call-ask",
            name: "ask_person",
            arguments: JSON.stringify({ question: "Submit the form?" }),
          },
        ],
      };
    });
    const click: HeadlessTool = {
      definition: browserClick,
      execute: async () => ({ ok: true }),
    };
    const agent = await bot({ tools: async () => [click] });
    agent.setMessages([{ id: "u1", role: "user", content: "Fill it in." }]);
    const before = llm.getRequests().length;

    const events = await run(agent, [browserClick]);

    // The click, then the question, and nothing after it.
    expect(llm.getRequests().length - before).toBe(2);
    expect(count(events, EventType.RUN_ERROR)).toBe(0);
    expect(agent.messages.at(-1)?.role).toBe("tool");
    expect(String(agent.messages.at(-1)?.content)).toContain(PUT_TO);
    expect(JSON.stringify(agent.messages)).not.toContain(ANSWERED_ITSELF);
  });

  test("asked alongside a click, the question still ends the turn once the click is done", async () => {
    llm.clearFixtures();
    llm.reset?.();
    llm.onMessage(/.*/, (request) =>
      request.messages.some((message) => message.role === "tool")
        ? { content: ANSWERED_ITSELF }
        : {
            toolCalls: [
              {
                id: "call-click",
                name: "computer_click",
                arguments: JSON.stringify({ ref: "e1" }),
              },
              {
                id: "call-ask",
                name: "ask_person",
                arguments: JSON.stringify({ question: "Submit the form?" }),
              },
            ],
          },
    );
    const click: HeadlessTool = {
      definition: browserClick,
      execute: async () => ({ ok: true }),
    };
    const agent = await bot({ tools: async () => [click] });
    agent.setMessages([{ id: "u1", role: "user", content: "Fill it in." }]);
    const before = llm.getRequests().length;

    const events = await run(agent, [browserClick]);

    // One model call: the segment after the click ends on the question without asking the model,
    // and is not taken for a silent turn and nudged or failed.
    expect(llm.getRequests().length - before).toBe(1);
    expect(count(events, EventType.RUN_ERROR)).toBe(0);
    expect(JSON.stringify(agent.messages)).toContain(PUT_TO);
    expect(JSON.stringify(agent.messages)).not.toContain(ANSWERED_ITSELF);
  });
});
