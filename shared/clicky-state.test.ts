import { describe, expect, test } from "bun:test";
import {
  CLICKY_NUDGE_AFTER_MS,
  CLICKY_PROPOSAL_TTL_MS,
  CLICKY_STATES,
  type ClickyCommand,
  type ClickySession,
  type ClickyState,
  newClickySession,
  visibleOverlays,
} from "./clicky";
import {
  type ClickyContext,
  type ClickyEvent,
  type ClickyPlan,
  type ClickyRatedAction,
  reduceClicky,
} from "./clicky-state";
import type { ClickyActionPolicy } from "./user-preferences";

const T0 = Date.parse("2026-10-14T10:00:00.000Z");

function harness(policy: ClickyActionPolicy = "ask_each") {
  let now = T0;
  let counter = 0;
  const context = (): ClickyContext => ({
    now,
    actionPolicy: policy,
    newId: () => `id-${++counter}`,
  });
  let session = newClickySession({ id: "s1", botId: "bot", now });
  const run = (event: ClickyEvent) => {
    const result = reduceClicky(session, event, context());
    session = result.session;
    return result;
  };
  const command = (command: ClickyCommand) => run({ type: "command", command });
  return {
    run,
    command,
    get session() {
      return session;
    },
    set session(next: ClickySession) {
      session = next;
    },
    advance(ms: number) {
      now += ms;
    },
    /** The think id of the model call in flight. */
    thinking() {
      expect(session.state).toBe("thinking");
      return session.thinkId ?? "";
    },
  };
}

const PLAN: ClickyPlan = {
  goal: "Search for flights",
  steps: [
    {
      title: "Click the search box",
      overlays: [
        {
          kind: "highlight",
          id: "h1",
          rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
        },
      ],
    },
    {
      title: "Type the city",
      overlays: [{ kind: "pointer", id: "p1", at: { x: 0.5, y: 0.5 } }],
    },
    { title: "Press Search", overlays: [] },
  ],
};

const CLICK: ClickyRatedAction = {
  action: { kind: "click", at: { x: 0.2, y: 0.12 }, label: "the search box" },
  why: "To start a search",
  risk: "low",
};

describe("waking, asking, answering", () => {
  test("wake opens a session once, with one audit row", () => {
    const h = harness();
    const first = h.command({ type: "wake" });
    expect(first.changed).toBe(true);
    expect(h.session.awake).toBe(true);
    expect(h.session.reply?.notice).toBe("awake");
    expect(first.effects).toEqual([
      {
        type: "audit",
        event: "clicky.session_started",
        detail: { botId: "bot", reason: "wake" },
      },
    ]);
    expect(h.command({ type: "wake" }).changed).toBe(false);
  });

  test("a question asks the model, and its answer guides", () => {
    const h = harness();
    const asked = h.command({ type: "ask", text: "  where do I search?  " });
    const think = asked.effects.find((effect) => effect.type === "think");
    expect(think).toMatchObject({
      type: "think",
      reason: "ask",
      text: "where do I search?",
    });
    const thinkId = h.thinking();
    h.run({ type: "brain.reply", thinkId, say: "Here, top left.", plan: PLAN });
    expect(h.session.state).toBe("guiding");
    expect(h.session.walkthrough?.steps.map((step) => step.status)).toEqual([
      "current",
      "pending",
      "pending",
    ]);
    expect(visibleOverlays(h.session)).toHaveLength(1);
    expect(h.session.transcript.map((turn) => turn.role)).toEqual([
      "person",
      "clicky",
    ]);
  });

  test("every change bumps seq; a refused command does not", () => {
    const h = harness();
    h.command({ type: "wake" });
    expect(h.session.seq).toBe(1);
    const refused = h.command({ type: "next" });
    expect(refused.rejected).toBe("no_step");
    expect(h.session.seq).toBe(1);
  });

  test("an answer to a question nobody waits on any more is dropped", () => {
    const h = harness();
    h.command({ type: "ask", text: "first" });
    const stale = h.thinking();
    const second = h.command({ type: "ask", text: "second" });
    expect(second.effects.map((effect) => effect.type)).toEqual([
      "cancel_think",
      "think",
    ]);
    expect(
      h.run({ type: "brain.reply", thinkId: stale, say: "late" }).changed,
    ).toBe(false);
    h.command({ type: "stop" });
    expect(
      h.run({
        type: "brain.reply",
        thinkId: h.session.thinkId ?? "x",
        say: "late",
      }).changed,
    ).toBe(false);
    expect(h.session.state).toBe("stopped");
  });

  test("a failed look is said plainly and can be retried", () => {
    const h = harness();
    h.command({ type: "ask", text: "help" });
    h.run({ type: "brain.failed", thinkId: h.thinking(), detail: "timeout" });
    expect(h.session.error).toEqual({
      notice: "think_failed",
      detail: "timeout",
    });
    const retried = h.command({ type: "retry" });
    expect(retried.effects).toContainEqual(
      expect.objectContaining({ type: "think", reason: "retry", text: "help" }),
    );
  });
});

describe("stop", () => {
  const states = CLICKY_STATES.filter((state) => state !== "stopped");
  test.each(states)(
    "is accepted from %s, aborts what runs, and returns to guide mode",
    (from) => {
      const h = harness("ask_once_per_task");
      h.session = {
        ...h.session,
        awake: true,
        state: from as ClickyState,
        mode: "act",
        thinkId: from === "thinking" ? "t1" : null,
        grant: {
          walkthroughId: null,
          grantedAt: "x",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
      const result = h.command({ type: "stop" });
      expect(result.changed).toBe(true);
      expect(h.session.state).toBe("stopped");
      expect(h.session.mode).toBe("guide");
      expect(h.session.grant).toBeNull();
      expect(h.session.proposal).toBeNull();
      const types = result.effects.map((effect) => effect.type);
      expect(types).toContain("audit");
      if (from === "acting") expect(types).toContain("abort_action");
      if (from === "thinking") expect(types).toContain("cancel_think");
    },
  );

  test("after stop, acting needs the person to turn it on again", () => {
    const h = harness();
    h.session = { ...h.session, awake: true, mode: "act" };
    h.command({ type: "stop" });
    h.command({ type: "ask", text: "click it for me" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "This one.",
      proposal: CLICK,
    });
    // Guide mode: the proposal becomes a pointer, never a request to act.
    expect(h.session.proposal).toBeNull();
    expect(h.session.state).toBe("guiding");
    expect(
      visibleOverlays(h.session).some((overlay) => overlay.kind === "pointer"),
    ).toBe(true);
  });
});

describe("approvals", () => {
  function proposing(policy: ClickyActionPolicy = "ask_each", rated = CLICK) {
    const h = harness(policy);
    h.command({ type: "wake" });
    h.command({ type: "set_mode", mode: "act" });
    h.command({ type: "ask", text: "do it" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "I'll click it.",
      proposal: rated,
    });
    return h;
  }

  test("a proposal waits for the person's yes", () => {
    const h = proposing();
    expect(h.session.state).toBe("awaiting_permission");
    const id = h.session.proposal?.id ?? "";
    const approved = h.command({
      type: "approve",
      proposalId: id,
      scope: "once",
    });
    expect(h.session.state).toBe("acting");
    expect(approved.effects.map((effect) => effect.type)).toEqual([
      "audit",
      "act",
    ]);
    h.run({ type: "action.done", proposalId: id });
    expect(h.session.state).not.toBe("acting");
    expect(h.session.proposal).toBeNull();
  });

  test("approving another, a stale or an expired proposal is refused", () => {
    const h = proposing();
    const id = h.session.proposal?.id ?? "";
    expect(
      h.command({ type: "approve", proposalId: "other", scope: "once" })
        .rejected,
    ).toBe("expired");
    h.advance(CLICKY_PROPOSAL_TTL_MS);
    expect(
      h.command({ type: "approve", proposalId: id, scope: "once" }).rejected,
    ).toBe("expired");
    h.run({ type: "tick" });
    expect(h.session.proposal).toBeNull();
    expect(h.session.reply?.notice).toBe("expired");
  });

  test("deny leaves a pointer so the person can do it", () => {
    const h = proposing();
    const id = h.session.proposal?.id ?? "";
    const denied = h.command({ type: "deny", proposalId: id });
    expect(denied.effects[0]).toMatchObject({ event: "clicky.action_denied" });
    expect(h.session.state).toBe("guiding");
    expect(
      visibleOverlays(h.session).some((overlay) => overlay.kind === "pointer"),
    ).toBe(true);
  });

  test("'for this task' covers later low-risk actions only, and only when the setting allows", () => {
    const h = proposing("ask_once_per_task");
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "task" });
    expect(h.session.grant).not.toBeNull();
    h.run({ type: "action.done", proposalId: id });
    h.command({ type: "ask", text: "and the next one" });
    const auto = h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Next.",
      proposal: CLICK,
    });
    expect(h.session.state).toBe("acting");
    expect(auto.effects.map((effect) => effect.type)).toContain("act");
    const autoId = h.session.proposal?.id ?? "";
    h.run({ type: "action.done", proposalId: autoId });
    h.command({ type: "ask", text: "submit it" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Submit?",
      proposal: { ...CLICK, risk: "confirm" },
    });
    expect(h.session.state).toBe("awaiting_permission");
  });

  test("with ask_each, 'for this task' is only a yes for this one", () => {
    const h = proposing("ask_each");
    h.command({
      type: "approve",
      proposalId: h.session.proposal?.id ?? "",
      scope: "task",
    });
    expect(h.session.grant).toBeNull();
  });

  test.each(["yours", "blocked"] as const)(
    "a %s action is pointed at, never proposed",
    (risk) => {
      const h = proposing("ask_once_per_task", {
        ...CLICK,
        risk,
        riskReason: "a password",
      });
      expect(h.session.proposal).toBeNull();
      expect(h.session.reply?.notice).toBe(risk);
      expect(
        visibleOverlays(h.session).some(
          (overlay) => overlay.kind === "pointer",
        ),
      ).toBe(true);
    },
  );

  test("guide only refuses 'Do it for me'", () => {
    const h = harness("never");
    expect(h.command({ type: "set_mode", mode: "act" }).rejected).toBe(
      "guide_only",
    );
    expect(h.session.mode).toBe("guide");
  });

  test("a failed action is reported and the task stays", () => {
    const h = proposing();
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "once" });
    expect(h.run({ type: "action.failed", proposalId: "other" }).changed).toBe(
      false,
    );
    h.run({ type: "action.failed", proposalId: id, detail: "gone" });
    expect(h.session.error?.notice).toBe("action_failed");
    expect(h.session.state).not.toBe("acting");
  });
});

describe("walkthroughs", () => {
  function guided() {
    const h = harness();
    h.command({ type: "ask", text: "how do I search?" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Three steps.",
      plan: PLAN,
    });
    return h;
  }

  test("next and back move through the steps and remember progress", () => {
    const h = guided();
    h.command({ type: "next" });
    expect(h.session.walkthrough?.steps.map((step) => step.status)).toEqual([
      "done",
      "current",
      "pending",
    ]);
    h.command({ type: "back" });
    expect(h.session.walkthrough?.steps.map((step) => step.status)).toEqual([
      "current",
      "pending",
      "pending",
    ]);
    h.command({ type: "next" });
    h.command({ type: "next" });
    h.command({ type: "next" });
    expect(h.session.walkthrough?.currentStepId).toBeNull();
    expect(h.session.reply?.notice).toBe("walkthrough_done");
  });

  test("a click on the current target counts as the step done", () => {
    const h = guided();
    expect(
      h.run({ type: "person.input", at: { x: 0.9, y: 0.9 } }).changed,
    ).toBe(false);
    h.run({ type: "person.input", at: { x: 0.15, y: 0.12 } });
    expect(h.session.walkthrough?.steps[0]?.status).toBe("done");
  });

  test("the stuck nudge comes once, after a quiet spell", () => {
    const h = guided();
    h.advance(CLICKY_NUDGE_AFTER_MS - 1);
    expect(h.run({ type: "tick" }).changed).toBe(false);
    h.advance(1);
    // Recent input on the screen means they are busy, not stuck.
    expect(
      h.run({ type: "tick", lastInputAt: T0 + CLICKY_NUDGE_AFTER_MS - 10 })
        .changed,
    ).toBe(false);
    h.advance(CLICKY_NUDGE_AFTER_MS);
    h.run({ type: "tick" });
    expect(h.session.reply?.notice).toBe("nudge");
    h.advance(CLICKY_NUDGE_AFTER_MS);
    expect(h.run({ type: "tick" }).changed).toBe(false);
  });

  test("after an action, Clicky looks again to propose the next step", () => {
    const h = harness();
    h.command({ type: "set_mode", mode: "act" });
    h.command({ type: "ask", text: "search for me" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "First, the box.",
      plan: PLAN,
      proposal: CLICK,
    });
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "once" });
    const done = h.run({ type: "action.done", proposalId: id });
    expect(h.session.state).toBe("thinking");
    expect(done.effects).toContainEqual(
      expect.objectContaining({ type: "think", reason: "continue" }),
    );
  });
});

describe("the Bot needs the person", () => {
  test("a handover activates Clicky once per request", () => {
    const h = harness();
    const first = h.command({
      type: "activate",
      trigger: {
        kind: "takeover",
        requestId: "r1",
        reason: "Please solve the check",
      },
    });
    expect(h.session.awake).toBe(true);
    expect(h.session.state).toBe("thinking");
    expect(h.session.reply?.notice).toBe("takeover");
    expect(first.effects.map((effect) => effect.type)).toEqual([
      "audit",
      "think",
    ]);
    expect(
      h.command({
        type: "activate",
        trigger: { kind: "takeover", requestId: "r1" },
      }).changed,
    ).toBe(false);
  });

  test("'Do it for me' on a handover looks and proposes at once", () => {
    const h = harness();
    h.command({
      type: "activate",
      trigger: { kind: "approval", requestId: "r2" },
    });
    h.run({ type: "brain.reply", thinkId: h.thinking(), say: "Click Allow." });
    const doIt = h.command({ type: "set_mode", mode: "act" });
    expect(doIt.effects).toContainEqual(
      expect.objectContaining({ type: "think", reason: "do_it" }),
    );
  });

  test.each(["sign_in", "secret", "challenge"] as const)(
    "'Do it for me' is refused while a %s is the person's to do",
    (kind) => {
      const h = harness("ask_once_per_task");
      h.command({ type: "activate", trigger: { kind, requestId: "r9" } });
      expect(h.command({ type: "set_mode", mode: "act" }).rejected).toBe(
        "yours",
      );
      expect(h.session.mode).toBe("guide");
    },
  );

  test("the handover ending clears its guidance and says thanks", () => {
    const h = harness();
    h.command({
      type: "activate",
      trigger: { kind: "sign_in", requestId: "r3" },
    });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Here.",
      plan: PLAN,
    });
    expect(
      h.run({
        type: "takeover.resolved",
        requestId: "other",
        outcome: "completed",
      }).changed,
    ).toBe(false);
    h.run({ type: "takeover.resolved", requestId: "r3", outcome: "completed" });
    expect(h.session.trigger).toBeNull();
    expect(h.session.walkthrough).toBeNull();
    expect(h.session.reply?.notice).toBe("takeover_resolved");
    expect(h.session.state).toBe("idle");
  });

  test("a finished Bot task becomes a follow-up while Clicky is open", () => {
    const h = harness();
    expect(h.run({ type: "bot.finished", summary: "Booked." }).changed).toBe(
      false,
    );
    h.command({ type: "wake" });
    h.run({ type: "bot.finished", summary: "Booked the table." });
    expect(h.session.reply).toEqual({
      text: "Booked the table.",
      final: true,
      notice: "follow_up",
    });
  });
});

describe("sleep, pause, listen", () => {
  test("sleep aborts an action and forgets the screen, but keeps the walkthrough", () => {
    const h = harness();
    h.command({ type: "ask", text: "how?" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Steps.",
      plan: PLAN,
    });
    h.session = { ...h.session, state: "acting" };
    const slept = h.command({ type: "sleep" });
    expect(slept.effects).toContainEqual({ type: "abort_action" });
    expect(h.session.awake).toBe(false);
    expect(h.session.walkthrough).not.toBeNull();
  });

  test("pause and resume return to where Clicky was", () => {
    const h = harness();
    h.command({ type: "ask", text: "how?" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Steps.",
      plan: PLAN,
    });
    h.command({ type: "pause" });
    expect(h.session.state).toBe("paused");
    h.command({ type: "resume" });
    expect(h.session.state).toBe("guiding");
  });

  test("hold to talk listens, and releasing returns to where it was", () => {
    const h = harness();
    h.command({ type: "listen", active: true });
    expect(h.session.state).toBe("listening");
    h.command({ type: "listen", active: false });
    expect(h.session.state).toBe("idle");
  });
});
