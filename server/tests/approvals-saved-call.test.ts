import { describe, expect, test } from "bun:test";
import {
  isTransientHistoryFailure,
  requireSavedToolCall,
} from "../src/approvals/saved-call";
import {
  ApprovalRefusedError,
  ApprovalUnavailableError,
} from "../src/approvals/types";

/**
 * The saved-conversation check behind every browser-side computer change.
 *
 * Three outcomes, kept apart on purpose: the call is saved and matches (allowed on), the call is
 * not there or not the same (refused), and the service could not be read at all (unavailable).
 * The third used to be reported as the second's cousin, "Supply a valid request.", which told the
 * person their own browser had sent nonsense while the conversation service was the one down.
 */

const platformError = (status: number, retryable = false) => {
  const error = new Error(`Intelligence platform error ${status}`);
  error.name = "PlatformRequestError";
  Object.assign(error, { status, retryable });
  return error;
};

const saved = (args = '{"ref": "e7", "snapshotId": 3}') => ({
  messages: [
    { id: "u1", role: "user", content: "Submit" },
    {
      id: "a1",
      role: "assistant",
      toolCalls: [{ id: "click-1", name: "computer_click", args }],
    },
  ],
});

const check = (
  reads: (() => Promise<ReturnType<typeof saved>>)[],
  attempts = reads.length,
) => {
  let index = 0;
  const warnings: { attempt: number; failure: string }[] = [];
  const promise = requireSavedToolCall({
    toolCallId: "click-1",
    toolName: "computer_click",
    args: { ref: "e7", snapshotId: 3 },
    read: () => {
      const read = reads[Math.min(index, reads.length - 1)];
      index++;
      return read ? read() : Promise.reject(new Error("no read"));
    },
    attempts,
    sleep: async () => undefined,
    warn: (detail) => warnings.push(detail),
  });
  return { promise, warnings, reads: () => index };
};

describe("the saved tool call a computer change is checked against", () => {
  test("passes once the service has the call, even when the first reads fail", async () => {
    const run = check([
      () => Promise.reject(platformError(502)),
      () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
      async () => saved(),
    ]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.warnings.map((warning) => warning.failure)).toEqual([
      "PlatformRequestError 502",
      "SyntaxError",
    ]);
  });

  test("waits for a call the service has not saved yet", async () => {
    const run = check([
      async () => ({ messages: [] }),
      async () => ({ messages: [] }),
      async () => saved(),
    ]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.reads()).toBe(3);
  });

  test("is unavailable, not refused, when the service never answered", async () => {
    const run = check([() => Promise.reject(platformError(502))], 4);
    await expect(run.promise).rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(run.reads()).toBe(4);
  });

  test("refuses a call the service never saved, once it could be read", async () => {
    const run = check(
      [
        () => Promise.reject(platformError(503)),
        async () => ({ messages: [] }),
      ],
      3,
    );
    await expect(run.promise).rejects.toBeInstanceOf(ApprovalRefusedError);
  });

  test("refuses a saved call whose arguments or answer differ", async () => {
    await expect(
      check([async () => saved('{"ref":"e9","snapshotId":3}')]).promise,
    ).rejects.toThrow("not saved in this conversation");
    await expect(
      check([async () => saved("not json")]).promise,
    ).rejects.toThrow("not saved in this conversation");
    const answered = saved();
    answered.messages.push({
      id: "t1",
      role: "tool",
      toolCallId: "click-1",
      content: "{}",
    } as never);
    await expect(check([async () => answered]).promise).rejects.toThrow(
      "not saved in this conversation",
    );
  });

  test("lets a refusal the service meant through unchanged", async () => {
    await expect(
      check([() => Promise.reject(platformError(401))]).promise,
    ).rejects.toThrow("Intelligence platform error 401");
  });

  test("knows which failures are the service's", () => {
    expect(isTransientHistoryFailure(platformError(502))).toBe(true);
    expect(isTransientHistoryFailure(platformError(429, true))).toBe(true);
    expect(isTransientHistoryFailure(new SyntaxError("bad json"))).toBe(true);
    expect(isTransientHistoryFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientHistoryFailure(platformError(404))).toBe(false);
    expect(isTransientHistoryFailure(platformError(401))).toBe(false);
    expect(isTransientHistoryFailure(new Error("other"))).toBe(false);
  });
});
