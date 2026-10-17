import { expect, test } from "bun:test";
import { questionsAnswered } from "@/lib/copilot/question-answers";

/**
 * What a message the person sends answers. Found live: answering a new Bot's first question the
 * moment its card appeared sent before the first turn was in the tab's messages, so the question
 * was never recorded as answered and the conversation offered it again under the reply.
 */
test("a question waiting on the server in this thread is answered too, when the transcript does not hold it", () => {
  expect(
    questionsAnswered(
      [],
      [
        {
          threadId: "thread-1",
          question: "What do you mainly want help with?",
        },
        { threadId: "thread-2", question: "Somewhere else?" },
      ],
      "thread-1",
    ),
  ).toEqual([{ question: "What do you mainly want help with?" }]);
});

test("the same question from both places is listed once, and blank ones not at all", () => {
  expect(
    questionsAnswered(
      [{ question: "Shall I go ahead?" }],
      [
        { threadId: "thread-1", question: " Shall I go ahead? " },
        { threadId: "thread-1", question: "  " },
      ],
      "thread-1",
    ),
  ).toEqual([{ question: "Shall I go ahead?" }]);
});

test("nothing open and nothing waiting answers nothing", () => {
  expect(questionsAnswered([], [], "thread-1")).toEqual([]);
});
