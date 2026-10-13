import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { ApprovalContinuation } from "../approvals/types";
import type { AppVariables } from "../auth/guards";
import type { HeadlessWait } from "../computer/headless-tools";
import type { ControlState } from "../computer/schema";
import type { Database } from "../db/client";
import { runWaits } from "../db/schema";

/**
 * A computer tool the server carried out inside a person's chat run that is now waiting on them,
 * and who resumes that run when they answer.
 *
 * With COMPUTER_TOOLS_IN_RUN on, a sign-in, a takeover, a secret or an approval ends the run at the
 * call that needs the person (HeadlessToolsMiddleware, interactive mode). The row written then is
 * claimed exactly once by whoever continues the run:
 *
 * - THE TAB, when it is open: it watches the request, claims the row the moment it is answered and
 *   starts the continuation run itself, so the answer streams in front of the person.
 * - THE SERVER, when no tab claimed it within a grace period after the answer: the sweep below
 *   continues the run headlessly, exactly as an approval or a routine's sign-in already does. This
 *   is what lets a turn survive the tab closing.
 *
 * An approval is never resumed from here: its decision executes the action once and continues the
 * conversation through the approval sweep, as it always has. The row only tells the tab what kind
 * of wait it is. Rows are purged after a day.
 */

export type RunWaitKind =
  | "computer_sign_in"
  | "computer_handoff"
  | "computer_secret"
  | "approval";

export type RunWait = {
  threadId: string;
  toolCallId: string;
  ownerUserId: string;
  botId: string;
  kind: string;
  requestId: string | null;
  waiting: Record<string, unknown>;
  continuation: ApprovalContinuation;
  createdAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
};

/** `expired`: nobody answered in time, or it could not be checked; nobody continues it. */
export type ClaimedBy = "tab" | "server" | "stopped" | "expired";

export type RunWaitStore = {
  open(
    wait: Omit<RunWait, "createdAt" | "claimedAt" | "claimedBy">,
  ): Promise<void>;
  get(
    ownerUserId: string,
    threadId: string,
    toolCallId: string,
  ): Promise<RunWait | undefined>;
  /** The row when THIS call claimed it; undefined when it was gone or already claimed. */
  claim(
    ownerUserId: string,
    threadId: string,
    toolCallId: string,
    by: ClaimedBy,
  ): Promise<RunWait | undefined>;
  /** Unclaimed rows of these kinds, oldest first, created after `after` when given. */
  listOpen(
    kinds: readonly string[],
    limit: number,
    after?: Date,
  ): Promise<RunWait[]>;
  purge(before: Date): Promise<number>;
};

/** How long a wait is kept, claimed or not. A request nobody answers expires long before this. */
export const RUN_WAIT_TTL_MS = 24 * 60 * 60_000;
/** The kinds the server itself resumes. */
export const SERVER_RESUMED_KINDS = [
  "computer_sign_in",
  "computer_handoff",
  "computer_secret",
] as const;

/** The row for a suspension, from what the interactive middleware handed over. */
export function waitFromSuspension(
  wait: HeadlessWait,
  owner: { ownerUserId: string; botId: string },
): Omit<RunWait, "createdAt" | "claimedAt" | "claimedBy"> {
  const { continuation, ...waiting } = wait.waiting;
  const requestId =
    typeof waiting.requestId === "string" ? waiting.requestId : null;
  return {
    threadId: wait.threadId,
    toolCallId: wait.toolCallId,
    ownerUserId: owner.ownerUserId,
    botId: owner.botId,
    kind: wait.waiting.kind,
    requestId,
    waiting: { ...waiting, message: wait.message },
    continuation: continuation as ApprovalContinuation,
  };
}

export function createRunWaitStore(database?: Database): RunWaitStore {
  if (!database) return createInMemoryRunWaitStore();
  const keyed = (ownerUserId: string, threadId: string, toolCallId: string) =>
    and(
      eq(runWaits.ownerUserId, ownerUserId),
      eq(runWaits.threadId, threadId),
      eq(runWaits.toolCallId, toolCallId),
    );
  const fromRow = (row: typeof runWaits.$inferSelect): RunWait => ({
    ...row,
    waiting: row.waiting as Record<string, unknown>,
    continuation: row.continuation as ApprovalContinuation,
  });
  return {
    async open(wait) {
      await database
        .insert(runWaits)
        .values(wait)
        // One wait per call: a second suspension of the same call replaces what it waits on.
        .onConflictDoUpdate({
          target: [runWaits.threadId, runWaits.toolCallId],
          set: {
            kind: wait.kind,
            requestId: wait.requestId,
            waiting: wait.waiting,
            continuation: wait.continuation,
            createdAt: new Date(),
            claimedAt: null,
            claimedBy: null,
          },
        });
    },
    async get(ownerUserId, threadId, toolCallId) {
      const [row] = await database
        .select()
        .from(runWaits)
        .where(keyed(ownerUserId, threadId, toolCallId))
        .limit(1);
      return row ? fromRow(row) : undefined;
    },
    async claim(ownerUserId, threadId, toolCallId, by) {
      // Checked and claimed in one statement: of the tab and the server, one wins.
      const [row] = await database
        .update(runWaits)
        .set({ claimedAt: new Date(), claimedBy: by })
        .where(
          and(
            keyed(ownerUserId, threadId, toolCallId),
            isNull(runWaits.claimedAt),
          ),
        )
        .returning();
      return row ? fromRow(row) : undefined;
    },
    async listOpen(kinds, limit, after) {
      const rows = await database
        .select()
        .from(runWaits)
        .where(
          and(
            isNull(runWaits.claimedAt),
            inArray(runWaits.kind, [...kinds]),
            ...(after ? [gt(runWaits.createdAt, after)] : []),
          ),
        )
        .orderBy(asc(runWaits.createdAt))
        .limit(limit);
      return rows.map(fromRow);
    },
    async purge(before) {
      const gone = await database
        .delete(runWaits)
        .where(lt(runWaits.createdAt, before))
        .returning({ toolCallId: runWaits.toolCallId });
      return gone.length;
    },
  };
}

function createInMemoryRunWaitStore(): RunWaitStore {
  const rows = new Map<string, RunWait>();
  const keyOf = (threadId: string, toolCallId: string) =>
    JSON.stringify([threadId, toolCallId]);
  const owned = (ownerUserId: string, threadId: string, toolCallId: string) => {
    const row = rows.get(keyOf(threadId, toolCallId));
    return row && row.ownerUserId === ownerUserId ? row : undefined;
  };
  return {
    async open(wait) {
      rows.set(keyOf(wait.threadId, wait.toolCallId), {
        ...wait,
        createdAt: new Date(),
        claimedAt: null,
        claimedBy: null,
      });
    },
    async get(ownerUserId, threadId, toolCallId) {
      const row = owned(ownerUserId, threadId, toolCallId);
      return row ? { ...row } : undefined;
    },
    async claim(ownerUserId, threadId, toolCallId, by) {
      const row = owned(ownerUserId, threadId, toolCallId);
      if (!row || row.claimedAt) return undefined;
      row.claimedAt = new Date();
      row.claimedBy = by;
      return { ...row };
    },
    async listOpen(kinds, limit, after) {
      return [...rows.values()]
        .filter(
          (row) =>
            !row.claimedAt &&
            kinds.includes(row.kind) &&
            (!after || row.createdAt > after),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit)
        .map((row) => ({ ...row }));
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

/** Whether a wait has been answered, and the tool result the run continues with once it has. */
export type WaitResolver = {
  ready(wait: RunWait): Promise<boolean>;
  /** Only asked once `ready` said yes. The content of the tool message the run resumes with. */
  result(wait: RunWait): Promise<string>;
};

/**
 * What a Bot is told when nobody took the wheel before the request lapsed. The same words the
 * browser uses (app/src/lib/computers/handoff.ts, NOBODY_TOOK_OVER), so a run resumed by the server
 * reads exactly like one resumed in the tab.
 */
export const NOBODY_TOOK_OVER =
  "Nobody took over before this request lapsed: the person is not at the screen. Do not ask again now. Say in one or two sentences what you need them to do and where you stopped, then end your turn. They will answer when they are back.";

const SIGN_IN_FINAL = new Set(["signed_in", "failed", "cancelled", "expired"]);

/**
 * The resolver a deployment uses: the sign-in request, the computer's control state, and a fresh
 * snapshot once a takeover is handed back, mirroring what the tab's handlers return.
 */
export function createWaitResolver(deps: {
  /**
   * The computer's lifecycle state, read WITHOUT waking it. A takeover or a secret can only have
   * been answered on a running computer, so one that is not running is not asked (asking would
   * resume a suspended computer every few seconds for a wait nobody is answering).
   */
  status?: (botId: string) => Promise<{ state: string }>;
  control?: (botId: string, requestId?: string) => Promise<ControlState>;
  snapshot?: (botId: string) => Promise<object>;
  signIn?: (
    ownerUserId: string,
    requestId: string,
  ) => Promise<{ status: string } | undefined>;
  signInResult?: (ownerUserId: string, requestId: string) => Promise<unknown>;
}): WaitResolver {
  const label = (wait: RunWait) => {
    const args = wait.continuation?.args;
    return args &&
      typeof args === "object" &&
      "label" in args &&
      typeof args.label === "string"
      ? args.label
      : "the value";
  };
  const running = async (botId: string) =>
    !deps.status || (await deps.status(botId)).state === "ready";
  return {
    async ready(wait) {
      if (
        (wait.kind === "computer_handoff" || wait.kind === "computer_secret") &&
        !(await running(wait.botId))
      )
        return false;
      if (wait.kind === "computer_sign_in") {
        if (!wait.requestId || !deps.signIn) return false;
        const request = await deps.signIn(wait.ownerUserId, wait.requestId);
        return !request || SIGN_IN_FINAL.has(request.status);
      }
      if (wait.kind === "computer_handoff") {
        if (!deps.control) return false;
        // The person took the wheel unasked: answered once they hand it back.
        if (!wait.requestId)
          return (await deps.control(wait.botId)).holder === "bot";
        const state = await deps.control(wait.botId, wait.requestId);
        const request = state.request;
        return (
          request?.id !== wait.requestId ||
          (request.status !== "waiting" && request.status !== "taken")
        );
      }
      if (wait.kind === "computer_secret") {
        if (!deps.control) return false;
        return (await deps.control(wait.botId)).secretWanted === undefined;
      }
      return false;
    },
    async result(wait) {
      if (wait.kind === "computer_sign_in") {
        const result =
          wait.requestId && deps.signInResult
            ? await deps.signInResult(wait.ownerUserId, wait.requestId)
            : undefined;
        return JSON.stringify(
          result ?? {
            ok: false,
            result:
              "The sign-in request is gone. Do not ask for the login another way.",
          },
        );
      }
      if (wait.kind === "computer_secret" && deps.control) {
        const state = await deps.control(wait.botId);
        const what = label(wait);
        const last =
          state.lastSecret &&
          new Date(state.lastSecret.at).getTime() >= wait.createdAt.getTime()
            ? state.lastSecret.outcome
            : "supplied";
        return JSON.stringify({
          ok: last === "supplied",
          outcome: last,
          result:
            last === "supplied"
              ? `The person has entered ${what} into the field. It was typed straight into the page and you were not told what it is.`
              : last === "field-gone"
                ? `The field had gone from the page before ${what} could be entered, so nothing was typed. Take a fresh snapshot, click the field again and ask again.`
                : last === "cancelled"
                  ? `The person declined to enter ${what}. Do not ask for it another way.`
                  : `Nobody entered ${what} in time. Do not ask for it another way.`,
        });
      }
      if (wait.kind === "computer_handoff" && deps.control) {
        const requestId = wait.requestId ?? undefined;
        const request = requestId
          ? (await deps.control(wait.botId, requestId)).request
          : undefined;
        if (requestId && request?.id !== requestId)
          return JSON.stringify({
            ok: false,
            requestId,
            reason:
              "The computer did not return the requested handoff. Nothing has been marked complete.",
          });
        if (!request || request.status === "completed") {
          const snapshot = deps.snapshot
            ? await deps.snapshot(wait.botId).catch(() => undefined)
            : undefined;
          if (!snapshot)
            return JSON.stringify({
              ok: false,
              requestId,
              handoffStatus: "completed",
              snapshotRequired: true,
              reason:
                "The person handed control back, but the page could not be read. Take a fresh snapshot.",
            });
          return JSON.stringify({
            ok: true,
            ...snapshot,
            requestId,
            handoffStatus: "completed",
            result:
              "The person handed control back. This fresh snapshot describes the page now.",
          });
        }
        return JSON.stringify({
          ok: false,
          requestId,
          handoffStatus: request.status,
          reason:
            request.interruption ??
            (request.status === "expired"
              ? NOBODY_TOOK_OVER
              : `The handoff was ${request.status}. The person has not completed this request.`),
        });
      }
      return JSON.stringify({
        ok: false,
        reason: "This request can no longer be resumed.",
      });
    },
  };
}

/**
 * The server's half: continue every answered wait no tab claimed within `graceMs` of the answer.
 *
 * Called on a schedule. A wait first seen answered starts its grace then, so an open tab, which
 * polls every second, nearly always claims it first and the person watches the answer stream in.
 *
 * KIND TO THE COMPUTERS AND TO THE QUEUE. A wait nobody is answering is checked less and less often
 * (doubling from `minDelayMs` to `maxDelayMs`), a wait that cannot be checked at all is given up
 * after `maxFailures` tries, and one older than `maxAgeMs` is expired: nobody is continuing a turn
 * from hours ago. The open waits are walked a page at a time from where the last sweep stopped, so
 * a run of waits that never become ready can never hold newer ones back.
 */
export function createRunWaitResumer(deps: {
  store: RunWaitStore;
  resolver: WaitResolver;
  continueTurn(wait: RunWait, content: string): Promise<void>;
  graceMs?: number;
  now?: () => number;
  /** Rows read per sweep, and how many of those may be checked. */
  pageSize?: number;
  checksPerSweep?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  maxFailures?: number;
  maxAgeMs?: number;
}) {
  const graceMs = deps.graceMs ?? 5_000;
  const now = deps.now ?? Date.now;
  const pageSize = deps.pageSize ?? 50;
  const checksPerSweep = deps.checksPerSweep ?? 10;
  const minDelayMs = deps.minDelayMs ?? 2_000;
  const maxDelayMs = deps.maxDelayMs ?? 60_000;
  const maxFailures = deps.maxFailures ?? 6;
  const maxAgeMs = deps.maxAgeMs ?? 2 * 60 * 60_000;
  /** Per wait: when it is next due, the current back-off, failures in a row, when first answered. */
  const schedule = new Map<
    string,
    { due: number; delay: number; failures: number; answeredAt?: number }
  >();
  let cursor: Date | undefined;
  const keyOf = (wait: RunWait) =>
    JSON.stringify([wait.threadId, wait.toolCallId]);
  const later = (key: string, failed: boolean) => {
    const slot = schedule.get(key) ?? { due: 0, delay: 0, failures: 0 };
    slot.delay = Math.min(
      maxDelayMs,
      slot.delay === 0 ? minDelayMs : slot.delay * 2,
    );
    slot.due = now() + slot.delay;
    slot.failures = failed ? slot.failures + 1 : 0;
    slot.answeredAt = undefined;
    schedule.set(key, slot);
    return slot;
  };
  const expire = async (wait: RunWait, key: string) => {
    schedule.delete(key);
    await deps.store
      .claim(wait.ownerUserId, wait.threadId, wait.toolCallId, "expired")
      .catch(() => undefined);
  };
  return async function sweep(): Promise<number> {
    let resumed = 0;
    let checked = 0;
    const from = cursor;
    const page = await deps.store.listOpen(
      SERVER_RESUMED_KINDS,
      pageSize,
      from,
    );
    // The next sweep continues after this page; a short page means the end, so start over.
    cursor = page.length < pageSize ? undefined : page.at(-1)?.createdAt;
    for (const wait of page) {
      const key = keyOf(wait);
      if (now() - wait.createdAt.getTime() >= maxAgeMs) {
        await expire(wait, key);
        continue;
      }
      const slot = schedule.get(key);
      if (slot && slot.due > now()) continue;
      if (checked >= checksPerSweep) break;
      checked++;
      let ready: boolean;
      try {
        ready = await deps.resolver.ready(wait);
      } catch {
        if (later(key, true).failures >= maxFailures) await expire(wait, key);
        continue;
      }
      if (!ready) {
        later(key, false);
        continue;
      }
      const answeredAt = slot?.answeredAt ?? now();
      if (now() - answeredAt < graceMs) {
        schedule.set(key, {
          due: answeredAt + graceMs,
          delay: 0,
          failures: 0,
          answeredAt,
        });
        continue;
      }
      let content: string;
      try {
        content = await deps.resolver.result(wait);
      } catch {
        if (later(key, true).failures >= maxFailures) await expire(wait, key);
        continue;
      }
      schedule.delete(key);
      const claimed = await deps.store.claim(
        wait.ownerUserId,
        wait.threadId,
        wait.toolCallId,
        "server",
      );
      if (!claimed) continue;
      try {
        await deps.continueTurn(claimed, content);
        resumed++;
      } catch (error) {
        console.error({
          error: "run_wait_resume_failed",
          context: {
            kind: claimed.kind,
            botId: claimed.botId,
            threadId: claimed.threadId,
            message: error instanceof Error ? error.message : String(error),
          },
          timestamp: new Date().toISOString(),
        });
      }
    }
    // Forget waits that have gone (claimed by a tab, purged): nothing has looked at them in ages.
    if (!from && page.length === 0) schedule.clear();
    else
      for (const [key, slot] of schedule)
        if (slot.due < now() - maxAgeMs) schedule.delete(key);
    return resumed;
  };
}

/**
 * The tab's half, at /api/runs/waits/:threadId/:toolCallId.
 *
 * GET says what the wait is and whether it has been answered. POST /claim takes it: with the tool
 * result the run continues with, built here from the request itself rather than anything the
 * browser says, or, with `{ stop: true }`, to say the person stopped the turn and nobody may
 * continue it. Only the person whose run it was can see or claim it.
 */
export function createRunWaitRoutes(
  store: RunWaitStore,
  resolver: WaitResolver,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.get("/waits/:threadId/:toolCallId", async (context) => {
    const wait = await store.get(
      context.var.actor.id,
      context.req.param("threadId"),
      context.req.param("toolCallId"),
    );
    if (!wait) return context.json({ error: "No such wait." }, 404);
    const status = wait.claimedAt
      ? "claimed"
      : (await resolver.ready(wait).catch(() => false))
        ? "ready"
        : "waiting";
    return context.json({
      kind: wait.kind,
      requestId: wait.requestId,
      status,
      ...(wait.claimedBy ? { claimedBy: wait.claimedBy } : {}),
    });
  });
  routes.post("/waits/:threadId/:toolCallId/claim", async (context) => {
    const body = z
      .object({ stop: z.boolean().optional() })
      .safeParse(await context.req.json().catch(() => ({})));
    const owner = context.var.actor.id;
    const threadId = context.req.param("threadId");
    const toolCallId = context.req.param("toolCallId");
    if (body.success && body.data.stop) {
      const stopped = await store.claim(owner, threadId, toolCallId, "stopped");
      return context.json({ claimed: Boolean(stopped) });
    }
    const wait = await store.get(owner, threadId, toolCallId);
    if (!wait) return context.json({ error: "No such wait." }, 404);
    if (wait.claimedAt) return context.json({ claimed: false });
    if (wait.kind === "approval" || !(await resolver.ready(wait)))
      return context.json({ claimed: false, status: "waiting" }, 409);
    const content = await resolver.result(wait);
    const claimed = await store.claim(owner, threadId, toolCallId, "tab");
    return claimed
      ? context.json({ claimed: true, content })
      : context.json({ claimed: false });
  });
  return routes;
}
