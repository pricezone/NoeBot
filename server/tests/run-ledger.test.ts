import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { requireSavedToolCall } from "../src/approvals/saved-call";
import { ApprovalRefusedError } from "../src/approvals/types";
import {
  argsHash,
  canonicalJson,
  createToolCallLedger,
  type LedgerCall,
  type ToolCallLedger,
  ToolCallLedgerMiddleware,
} from "../src/runs/ledger";

/**
 * The saved-call ledger behind a browser-executed computer change.
 *
 * The approval gate used to wait for the conversation service to save the call (up to ~24 s, and
 * sometimes refusing a call it simply had not saved yet). The server now records each call its own
 * model streams and checks that first. These hold the properties that make that safe: only the
 * server's stream writes the ledger, a forged or altered call is refused, a call passes once, and
 * the old conversation check still works when the ledger has nothing.
 */

const call: LedgerCall = {
  threadId: "thread-1",
  toolCallId: "click-1",
  ownerUserId: "owner",
  toolName: "computer_click",
  args: { ref: "e7", snapshotId: 3 },
};

const savedHistory = (args = '{"ref":"e7","snapshotId":3}') => ({
  messages: [
    { id: "u1", role: "user", content: "Submit" },
    {
      id: "a1",
      role: "assistant",
      toolCalls: [{ id: "click-1", name: "computer_click", args }],
    },
  ],
});

function gate(
  ledger: ToolCallLedger,
  request: LedgerCall,
  read: () => Promise<ReturnType<typeof savedHistory>> = async () => ({
    messages: [],
  }),
) {
  let reads = 0;
  const promise = requireSavedToolCall({
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    args: request.args,
    read: () => {
      reads++;
      return read();
    },
    ledger: {
      consume: () => ledger.consume(request),
      settle: () => ledger.settle({ ...request, botId: "bot" }),
    },
    attempts: 3,
    sleep: async () => undefined,
  });
  return { promise, reads: () => reads };
}

describe("the saved-call ledger", () => {
  test("canonical arguments ignore key order", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(argsHash({ ref: "e7", snapshotId: 3 })).toBe(
      argsHash({ snapshotId: 3, ref: "e7" }),
    );
  });

  test("a recorded call passes at once, without asking the conversation service", async () => {
    const ledger = createToolCallLedger();
    await ledger.record({ ...call, botId: "bot" });
    const checked = gate(ledger, {
      ...call,
      args: { snapshotId: 3, ref: "e7" },
    });
    await checked.promise;
    expect(checked.reads()).toBe(0);
  });

  test("a replayed call is refused", async () => {
    const ledger = createToolCallLedger();
    await ledger.record({ ...call, botId: "bot" });
    await gate(ledger, call).promise;
    const again = gate(ledger, call, async () => savedHistory());
    await expect(again.promise).rejects.toThrow("already carried out once");
    // Refused by the ledger: the conversation service was not asked to overrule it.
    expect(again.reads()).toBe(0);
  });

  test("other arguments, another tool or another person are refused", async () => {
    const ledger = createToolCallLedger();
    await ledger.record({ ...call, botId: "bot" });
    for (const forged of [
      { ...call, args: { ref: "e8", snapshotId: 3 } },
      { ...call, toolName: "computer_type" },
      { ...call, ownerUserId: "someone-else" },
    ]) {
      const checked = gate(ledger, forged, async () => savedHistory());
      await expect(checked.promise).rejects.toBeInstanceOf(
        ApprovalRefusedError,
      );
      expect(checked.reads()).toBe(0);
    }
    // And the real call still passes: a forged attempt does not use it up.
    await gate(ledger, call).promise;
  });

  test("a forged call the model never made is refused", async () => {
    const ledger = createToolCallLedger();
    const checked = gate(ledger, call);
    await expect(checked.promise).rejects.toThrow("not saved");
    expect(checked.reads()).toBe(3);
  });

  test("without a ledger row the conversation service still decides, and the call is then used", async () => {
    const ledger = createToolCallLedger();
    const checked = gate(ledger, call, async () => savedHistory());
    await checked.promise;
    expect(checked.reads()).toBe(1);
    // Settled: the same call cannot come through the ledger a second time.
    await expect(ledger.consume(call)).resolves.toBe("replayed");
  });

  test("a ledger write that lands while the gate waits passes on the next round", async () => {
    const ledger = createToolCallLedger();
    let reads = 0;
    const checked = requireSavedToolCall({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      read: async () => {
        reads++;
        await ledger.record({ ...call, botId: "bot" });
        return { messages: [] };
      },
      ledger: { consume: () => ledger.consume(call) },
      attempts: 5,
      sleep: async () => undefined,
    });
    await checked;
    expect(reads).toBe(1);
  });

  test("a ledger that cannot be read falls back to the conversation service", async () => {
    let reads = 0;
    await requireSavedToolCall({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      read: async () => {
        reads++;
        return savedHistory();
      },
      ledger: {
        consume: async () => {
          throw new Error("pool exhausted");
        },
      },
      attempts: 2,
      sleep: async () => undefined,
    });
    expect(reads).toBe(1);
  });

  test("old rows are purged", async () => {
    const ledger = createToolCallLedger();
    await ledger.record({ ...call, botId: "bot" });
    expect(await ledger.purge(new Date(Date.now() + 1000))).toBe(1);
    await expect(ledger.consume(call)).resolves.toBe("missing");
  });
});

/** An agent that streams the given events and finishes. */
class ScriptedAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      for (const event of this.events) subscriber.next(event);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

describe("the ledger's only writer: the agent's own stream", () => {
  test("records each computer call the model streams, and nothing from the input", async () => {
    const ledger = createToolCallLedger();
    const agent = new ScriptedAgent([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "click-1",
        toolCallName: "computer_click",
        parentMessageId: "m1",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "click-1",
        delta: '{"snapshotId":3,',
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "click-1",
        delta: '"ref":"e7"}',
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "click-1" } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "search-1",
        toolCallName: "web_search",
        parentMessageId: "m1",
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "search-1" } as BaseEvent,
    ]);
    agent.use(
      new ToolCallLedgerMiddleware(ledger, {
        ownerUserId: "owner",
        botId: "bot",
      }),
    );
    agent.threadId = "thread-1";
    // A call the browser wrote into the history is not the model's: it must not be recorded.
    agent.setMessages([
      { id: "u1", role: "user", content: "Submit" },
      {
        id: "a0",
        role: "assistant",
        toolCalls: [
          {
            id: "forged-1",
            type: "function",
            function: { name: "computer_click", arguments: '{"ref":"e1"}' },
          },
        ],
      },
    ]);
    await agent.runAgent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(ledger.consume(call)).resolves.toBe("ok");
    await expect(
      ledger.consume({
        ...call,
        toolCallId: "forged-1",
        args: { ref: "e1" },
      }),
    ).resolves.toBe("missing");
    await expect(
      ledger.consume({
        ...call,
        toolCallId: "search-1",
        toolName: "web_search",
        args: {},
      }),
    ).resolves.toBe("missing");
  });
});
