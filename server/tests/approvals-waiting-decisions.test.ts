import { describe, expect, test } from "bun:test";
import {
  createMemoryWaitingDecisionStore,
  DECISION_FORGOTTEN_MS,
  DECISION_STALE_MS,
} from "../src/approvals/decisions";
import { createApprovalRoutes } from "../src/approvals/routes";
import type { ApprovalService } from "../src/approvals/service";

/**
 * A decision card a run is waiting on, kept on the server so another tab can draw it and answer it.
 *
 * The tab running the turn opens the card and heartbeats it; the person answers in any tab; the
 * running tab picks the answer up and closes the card. Only the person it belongs to sees or answers
 * it, and an answer for a tab that has gone quiet is refused so it can travel as a message instead.
 */

const choice = {
  botId: "assistant",
  channelId: "channel-1",
  toolCallId: "call-choice",
  kind: "choice" as const,
  args: {
    title: "Which environment?",
    options: [
      { id: "staging", label: "Staging" },
      { id: "production", label: "Production" },
    ],
  },
};

function harness() {
  let clock = new Date("2026-10-13T10:00:00.000Z");
  const store = createMemoryWaitingDecisionStore({ now: () => clock });
  const service = { decisions: store } as unknown as ApprovalService;
  const as = (owner: string) =>
    createApprovalRoutes(service, async (context, next) => {
      context.set("actor", {
        id: owner,
        email: `${owner}@openbot.test`,
        role: "user",
      });
      await next();
    });
  const call = (
    owner: string,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    as(owner).request(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  return {
    store,
    call,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe("waiting decision records", () => {
  test("open, heartbeat, answer from another tab, close: the whole life of one card", async () => {
    const { call, advance } = harness();
    const opened = await call("owner", "/decisions", choice);
    expect(opened.status).toBe(201);
    expect((await opened.json()).decision).toMatchObject({
      toolCallId: "call-choice",
      kind: "choice",
      live: true,
      answer: null,
      closed: false,
    });

    // Listed for the conversation it was asked in, and nowhere else.
    const listed = await (
      await call("owner", "/decisions?channelId=channel-1")
    ).json();
    expect(listed.decisions).toHaveLength(1);
    expect(
      (await (await call("owner", "/decisions?channelId=other")).json())
        .decisions,
    ).toHaveLength(0);

    advance(DECISION_STALE_MS - 1000);
    const beat = await call("owner", "/decisions/call-choice/heartbeat", {});
    expect((await beat.json()).decision.live).toBe(true);
    advance(DECISION_STALE_MS - 1000);

    // Still live thanks to the heartbeat, so an answer from another tab is taken.
    const answered = await call("owner", "/decisions/call-choice/answer", {
      answer: { choice: "staging", label: "Staging" },
    });
    expect(answered.status).toBe(200);
    expect((await answered.json()).decision.answer).toEqual({
      choice: "staging",
      label: "Staging",
    });

    // A second answer is refused: the card was answered.
    const again = await call("owner", "/decisions/call-choice/answer", {
      answer: { choice: "production", label: "Production" },
    });
    expect(again.status).toBe(409);
    expect((await again.json()).reason).toBe("answered");

    // The running tab hands the answer to its run and closes the card; the answer stays readable.
    const closed = await call("owner", "/decisions/call-choice/close", {});
    expect((await closed.json()).decision).toMatchObject({
      closed: true,
      live: false,
      answer: { choice: "staging", label: "Staging" },
    });
    expect(
      (await (await call("owner", "/decisions")).json()).decisions,
    ).toHaveLength(0);
    const read = await (await call("owner", "/decisions/call-choice")).json();
    expect(read.decision.answer).toEqual({
      choice: "staging",
      label: "Staging",
    });
  });

  test("another person can neither see, answer, heartbeat nor close somebody's card", async () => {
    const { call } = harness();
    await call("owner", "/decisions", choice);
    expect(
      (await (await call("intruder", "/decisions")).json()).decisions,
    ).toEqual([]);
    expect((await call("intruder", "/decisions/call-choice")).status).toBe(404);
    expect(
      (
        await call("intruder", "/decisions/call-choice/answer", {
          answer: { choice: "production", label: "Production" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("intruder", "/decisions/call-choice/heartbeat", {})).status,
    ).toBe(404);
    expect(
      (await call("intruder", "/decisions/call-choice/close", {})).status,
    ).toBe(404);
    // The same tool call id opened by somebody else is their own card, not a takeover of this one.
    await call("intruder", "/decisions", choice);
    const mine = await (await call("owner", "/decisions/call-choice")).json();
    expect(mine.decision.answer).toBeNull();
    expect(mine.decision.closed).toBe(false);
  });

  test("an answer for a tab gone quiet is refused as stale, so it can be sent as a message", async () => {
    const { call, advance } = harness();
    await call("owner", "/decisions", choice);
    advance(DECISION_STALE_MS + 1);
    const read = await (await call("owner", "/decisions/call-choice")).json();
    expect(read.decision.live).toBe(false);
    const answer = await call("owner", "/decisions/call-choice/answer", {
      answer: { choice: "staging", label: "Staging" },
    });
    expect(answer.status).toBe(409);
    expect((await answer.json()).reason).toBe("stale");
    // Sent as a message instead, then closed with the answer so no tab offers it again.
    const closed = await call("owner", "/decisions/call-choice/close", {
      answer: { choice: "staging", label: "Staging" },
    });
    expect((await closed.json()).decision).toMatchObject({
      closed: true,
      answer: { choice: "staging", label: "Staging" },
    });
  });

  test("an answer that does not fit the card is refused, and a card nobody has heard from in a long while is forgotten", async () => {
    const { call, advance, store } = harness();
    await call("owner", "/decisions", {
      ...choice,
      toolCallId: "call-approval",
      kind: "approval",
      args: { title: "Refund this order?", summary: "Charged twice." },
    });
    const wrong = await call("owner", "/decisions/call-approval/answer", {
      answer: { choice: "staging", label: "Staging" },
    });
    expect(wrong.status).toBe(400);
    const right = await call("owner", "/decisions/call-approval/answer", {
      answer: { decision: "declined", note: "Not yet" },
    });
    expect((await right.json()).decision.answer).toEqual({
      decision: "declined",
      note: "Not yet",
    });

    await call("owner", "/decisions", choice);
    advance(DECISION_FORGOTTEN_MS + 1);
    expect(await store.list("owner")).toEqual([]);
    expect((await store.get("owner", "call-choice")).closed).toBe(true);
  });

  test("opening again is a heartbeat and never reopens or overwrites an answered card", async () => {
    const { store, advance } = harness();
    await store.open("owner", choice);
    await store.answer("owner", "call-choice", {
      choice: "staging",
      label: "Staging",
    });
    advance(5000);
    const reopened = await store.open("owner", {
      ...choice,
      args: { title: "Something else" },
    });
    expect(reopened.args.title).toBe("Which environment?");
    expect(reopened.answer).toEqual({ choice: "staging", label: "Staging" });
    await store.close("owner", "call-choice");
    expect((await store.open("owner", choice)).closed).toBe(true);
  });

  test("a deployment without the store answers the routes with a refusal, not a crash", async () => {
    const routes = createApprovalRoutes(
      {} as unknown as ApprovalService,
      async (context, next) => {
        context.set("actor", {
          id: "owner",
          email: "owner@openbot.test",
          role: "user",
        });
        await next();
      },
    );
    expect((await routes.request("/decisions")).status).toBe(400);
  });
});
