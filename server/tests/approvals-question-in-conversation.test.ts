import { describe, expect, test } from "bun:test";
import {
  answeredInConversation,
  type PersonQuestion,
} from "../src/approvals/questions";
import { createApprovalRoutes } from "../src/approvals/routes";
import type { ApprovalService } from "../src/approvals/service";

/**
 * A Bot's question answered in the conversation it was asked in — an option picked on its card, or
 * words typed in reply — is closed in Approvals with that answer, and nothing resumes the
 * conversation a second time. The database half is in the matching `.integration.test.ts`.
 */

const question = (over: Partial<PersonQuestion> = {}): PersonQuestion => ({
  actorId: "owner",
  botId: "new-bot",
  threadId: "thread-1",
  runId: "run-1",
  question: "What do you mainly want help with?",
  mode: "completed_question",
  initiator: { kind: "person" },
  ...over,
});

describe("which saved questions a reply in the conversation answers", () => {
  const reply = {
    threadId: "thread-1",
    questions: ["  What do you mainly want help with? "],
  };

  test("the same question, asked in the same conversation", () => {
    expect(answeredInConversation(question(), reply)).toBe(true);
  });

  test("not one asked in another conversation, or a different question", () => {
    expect(
      answeredInConversation(question({ threadId: "thread-2" }), reply),
    ).toBe(false);
    expect(
      answeredInConversation(question({ question: "Which account?" }), reply),
    ).toBe(false);
  });

  test("not a responsibility's, whose run waits for the inbox's answer to resume", () => {
    expect(
      answeredInConversation(
        question({ initiator: { kind: "responsibility", id: "goal-1" } }),
        reply,
      ),
    ).toBe(false);
  });

  test("a routine's question answered in the conversation is closed too", () => {
    expect(
      answeredInConversation(
        question({ initiator: { kind: "routine", id: "routine-1" } }),
        reply,
      ),
    ).toBe(true);
  });
});

describe("POST /api/approvals/questions/answered", () => {
  function routes() {
    const calls: unknown[][] = [];
    const service = {
      answerQuestionsInConversation: async (...input: unknown[]) => {
        calls.push(input);
        return { resolved: ["question-key"] };
      },
    } as unknown as ApprovalService;
    const app = createApprovalRoutes(service, async (context, next) => {
      context.set("actor", {
        id: "owner",
        email: "owner@example.com",
        role: "user",
      });
      await next();
    });
    return { app, calls };
  }
  const post = (app: ReturnType<typeof routes>["app"], body: unknown) =>
    app.request("/questions/answered", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("closes the caller's own questions with what they said", async () => {
    const { app, calls } = routes();

    const response = await post(app, {
      threadId: "thread-1",
      questions: ["What do you mainly want help with?"],
      response: " Research and writing ",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resolved: ["question-key"] });
    expect(calls).toEqual([
      [
        "owner",
        {
          threadId: "thread-1",
          questions: ["What do you mainly want help with?"],
          response: "Research and writing",
        },
      ],
    ]);
  });

  test("refuses a reply with no words, no questions, or anything else in it", async () => {
    const { app, calls } = routes();
    const valid = {
      threadId: "thread-1",
      questions: ["Which account?"],
      response: "The second",
    };

    for (const body of [
      { ...valid, response: "  " },
      { ...valid, questions: [] },
      { ...valid, ownerUserId: "somebody-else" },
    ])
      expect((await post(app, body)).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
