import { createHash } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  Middleware,
  type RunAgentInput,
} from "@ag-ui/client";
import { and, eq, isNull, lt } from "drizzle-orm";
import { type Observable, tap } from "rxjs";
import type { Database } from "../db/client";
import { runToolCalls } from "../db/schema";

/**
 * The saved-call ledger: every computer tool call a run's model streamed, recorded by the server
 * itself, so the approval gate can check a browser-executed action in one database read instead of
 * polling the conversation service until it has saved the call (up to ~24 s, sometimes refusing).
 *
 * ANTI-FORGERY. Rows are written only by {@link ToolCallLedgerMiddleware}, which sits on the agent's
 * own event stream on the server. Nothing a browser sends reaches `record`. A call that is not in
 * the ledger is not refused for that alone: the gate falls back to the conversation service.
 *
 * NO REPLAY. `consume` marks the row used in the same statement that checks it, so one model call
 * is carried out once, whichever replica the request lands on.
 */

/** Canonical JSON: objects with their keys sorted, recursively. `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** The hash a row keeps for a call's arguments; a model's empty argument string is `{}`. */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

/** A model's argument string as a value, `{}` for an empty one, or undefined for one that is not JSON. */
export function parseCallArguments(text: string): unknown {
  try {
    return JSON.parse(text.trim() || "{}");
  } catch {
    return undefined;
  }
}

export type LedgerCall = {
  threadId: string;
  toolCallId: string;
  ownerUserId: string;
  toolName: string;
  args: unknown;
};

/**
 * - `ok`: recorded, same name, same arguments, same person, not used before; now marked used.
 * - `missing`: not recorded (yet, or the write failed). The caller falls back to the conversation.
 * - `replayed`: recorded and already carried out once.
 * - `mismatch`: recorded with another name, other arguments, or for another person.
 */
export type LedgerVerdict = "ok" | "missing" | "replayed" | "mismatch";

export type ToolCallLedger = {
  record(call: LedgerCall & { botId: string }): Promise<void>;
  consume(call: LedgerCall): Promise<LedgerVerdict>;
  /** A call the conversation service vouched for: mark it used so the ledger cannot pass it again. */
  settle(call: LedgerCall & { botId: string }): Promise<void>;
  /** Drop rows older than `before`. Returns how many went. */
  purge(before: Date): Promise<number>;
};

/** How long a row is kept. A browser executes a call within seconds of its run ending. */
export const LEDGER_TTL_MS = 24 * 60 * 60_000;

type Row = {
  ownerUserId: string;
  botId: string;
  toolName: string;
  argsHash: string;
  createdAt: Date;
  usedAt: Date | null;
};

function verdictFor(row: Row | undefined, call: LedgerCall): LedgerVerdict {
  if (!row) return "missing";
  if (
    row.ownerUserId !== call.ownerUserId ||
    row.toolName !== call.toolName ||
    row.argsHash !== argsHash(call.args)
  )
    return "mismatch";
  return row.usedAt ? "replayed" : "ok";
}

/** The ledger a deployment uses, or an in-memory one (tests, a process with no database). */
export function createToolCallLedger(database?: Database): ToolCallLedger {
  if (!database) return createInMemoryLedger();
  return {
    async record(call) {
      await database
        .insert(runToolCalls)
        .values({
          threadId: call.threadId,
          toolCallId: call.toolCallId,
          ownerUserId: call.ownerUserId,
          botId: call.botId,
          toolName: call.toolName,
          argsHash: argsHash(call.args),
        })
        // A call id is the model's and unique in its conversation; a second write of it changes nothing.
        .onConflictDoNothing();
    },
    async consume(call) {
      const key = and(
        eq(runToolCalls.threadId, call.threadId),
        eq(runToolCalls.toolCallId, call.toolCallId),
      );
      const [row] = await database
        .select()
        .from(runToolCalls)
        .where(key)
        .limit(1);
      const verdict = verdictFor(row, call);
      if (verdict !== "ok") return verdict;
      // Checked and used in one statement: of two requests racing for one call, one wins.
      const used = await database
        .update(runToolCalls)
        .set({ usedAt: new Date() })
        .where(and(key, isNull(runToolCalls.usedAt)))
        .returning({ toolCallId: runToolCalls.toolCallId });
      return used.length === 1 ? "ok" : "replayed";
    },
    async settle(call) {
      await database
        .insert(runToolCalls)
        .values({
          threadId: call.threadId,
          toolCallId: call.toolCallId,
          ownerUserId: call.ownerUserId,
          botId: call.botId,
          toolName: call.toolName,
          argsHash: argsHash(call.args),
          usedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [runToolCalls.threadId, runToolCalls.toolCallId],
          set: { usedAt: new Date() },
        });
    },
    async purge(before) {
      const gone = await database
        .delete(runToolCalls)
        .where(lt(runToolCalls.createdAt, before))
        .returning({ toolCallId: runToolCalls.toolCallId });
      return gone.length;
    },
  };
}

function createInMemoryLedger(): ToolCallLedger {
  const rows = new Map<string, Row>();
  const keyOf = (call: { threadId: string; toolCallId: string }) =>
    JSON.stringify([call.threadId, call.toolCallId]);
  return {
    async record(call) {
      const key = keyOf(call);
      if (rows.has(key)) return;
      rows.set(key, {
        ownerUserId: call.ownerUserId,
        botId: call.botId,
        toolName: call.toolName,
        argsHash: argsHash(call.args),
        createdAt: new Date(),
        usedAt: null,
      });
    },
    async consume(call) {
      const row = rows.get(keyOf(call));
      const verdict = verdictFor(row, call);
      if (verdict === "ok" && row) row.usedAt = new Date();
      return verdict;
    },
    async settle(call) {
      const key = keyOf(call);
      const row = rows.get(key);
      if (row) row.usedAt = new Date();
      else
        rows.set(key, {
          ownerUserId: call.ownerUserId,
          botId: call.botId,
          toolName: call.toolName,
          argsHash: argsHash(call.args),
          createdAt: new Date(),
          usedAt: new Date(),
        });
    },
    async purge(before) {
      let gone = 0;
      for (const [key, row] of rows)
        if (row.createdAt < before) {
          rows.delete(key);
          gone++;
        }
      return gone;
    },
  };
}

/**
 * Records every computer tool call the agent's model streams, on the server, as it streams.
 *
 * Reads only the agent's own TOOL_CALL_START / ARGS / END events, never `input.messages` (which the
 * browser wrote). The write is not awaited by the stream: a browser can only act on a call after
 * the run's last event reaches it, well after this write, and a write that fails leaves the gate
 * its slower fallback rather than failing the run.
 */
export class ToolCallLedgerMiddleware extends Middleware {
  constructor(
    private readonly ledger: ToolCallLedger,
    private readonly owner: { ownerUserId: string; botId: string },
  ) {
    super();
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    const calls = new Map<string, { name: string; args: string }>();
    return this.runNext(input, next).pipe(
      tap((event) => {
        if (event.type === EventType.TOOL_CALL_START) {
          const start = event as BaseEvent & {
            toolCallId: string;
            toolCallName: string;
          };
          if (start.toolCallName.startsWith("computer_"))
            calls.set(start.toolCallId, { name: start.toolCallName, args: "" });
        } else if (event.type === EventType.TOOL_CALL_ARGS) {
          const delta = event as BaseEvent & {
            toolCallId: string;
            delta: string;
          };
          const call = calls.get(delta.toolCallId);
          if (call) call.args += delta.delta;
        } else if (event.type === EventType.TOOL_CALL_END) {
          const end = event as BaseEvent & { toolCallId: string };
          const call = calls.get(end.toolCallId);
          if (!call) return;
          calls.delete(end.toolCallId);
          const args = parseCallArguments(call.args);
          // Arguments that are not JSON could never match a request; nothing to record.
          if (args === undefined) return;
          void this.ledger
            .record({
              threadId: input.threadId,
              toolCallId: end.toolCallId,
              ownerUserId: this.owner.ownerUserId,
              botId: this.owner.botId,
              toolName: call.name,
              args,
            })
            .catch((error: unknown) => {
              // The name only: a database error can carry connection details or row contents.
              console.warn({
                error: "tool_call_ledger_write_failed",
                context: {
                  botId: this.owner.botId,
                  threadId: input.threadId,
                  name: error instanceof Error ? error.name : "unknown",
                },
                timestamp: new Date().toISOString(),
              });
            });
        }
      }),
    );
  }
}
