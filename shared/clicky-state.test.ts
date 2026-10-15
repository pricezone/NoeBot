import { describe, expect, test } from "bun:test";
import {
  CLICKY_NUDGE_AFTER_MS,
  CLICKY_SESSION_GRANT_TTL_MS,
  CLICKY_PROPOSAL_TTL_MS,
  CLICKY_STATES,
  type ClickyCommand,
  type ClickySession,
  type ClickyState,
  newClickySession,
  normalizeClickySession,
  visibleOverlays,
} from "./clicky";
import {
  type ClickyContext,
  type ClickyEvent,
  type ClickyPlan,
  type ClickyRatedAction,
  reduceClicky,
} from "./clicky-state";
import {
  type ClickyActionPolicy,
  clickyPreferencesOf,
} from "./user-preferences";

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

  /** A walkthrough whose steps point at e1, e2 and e3, and Clicky proposing a click on e1. */
  function walking(policy: ClickyActionPolicy = "ask_once_per_session") {
    const h = harness(policy);
    h.command({ type: "wake" });
    h.command({ type: "set_mode", mode: "act" });
    h.command({ type: "ask", text: "book it" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Three steps.",
      plan: {
        goal: "Book",
        steps: ["e1", "e2", "e3"].map((ref) => ({
          title: `Press ${ref}`,
          overlays: [],
          targetRef: ref,
        })),
      },
    });
    h.command({ type: "show_me" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "First this.",
      proposal: { ...CLICK, action: { ...CLICK.action, ref: "e1" } },
    });
    return h;
  }

  const onStep = (ref: string, risk: ClickyRatedAction["risk"] = "low") => ({
    ...CLICK,
    risk,
    action: { ...CLICK.action, ref },
  });

  test("'for this session' then runs every everyday action without asking, on or off the plan", () => {
    const h = walking();
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "session" });
    expect(h.session.grant?.scope).toBe("session");
    h.run({ type: "action.done", proposalId: id });
    for (const proposal of [
      onStep("e9"),
      {
        action: { kind: "key", keys: "Enter", label: "Enter" },
        why: "search",
        risk: "low",
      } satisfies ClickyRatedAction,
      {
        action: {
          kind: "scroll",
          at: { x: 0.5, y: 0.5 },
          deltaY: 600,
          label: "the page",
        },
        why: "see more",
        risk: "low",
      } satisfies ClickyRatedAction,
    ]) {
      const auto = h.run({
        type: "brain.reply",
        thinkId: h.thinking(),
        say: "Next.",
        proposal,
      });
      expect(h.session.state).toBe("acting");
      expect(auto.effects).toContainEqual(
        expect.objectContaining({ type: "act", viaGrant: true }),
      );
      expect(auto.effects).toContainEqual(
        expect.objectContaining({
          event: "clicky.action_approved",
          detail: expect.objectContaining({ scope: "session" }),
        }),
      );
      h.run({ type: "action.done", proposalId: h.session.proposal?.id ?? "" });
      if (h.session.state !== "thinking") h.command({ type: "show_me" });
    }
  });

  test("a step that is hard to undo is asked about even on its own element", () => {
    const h = walking();
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "task" });
    h.run({ type: "action.done", proposalId: id });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Submit?",
      proposal: onStep("e2", "confirm"),
    });
    expect(h.session.state).toBe("awaiting_permission");
  });

  test("with 'ask every time', 'for this session' is a yes for this one only", () => {
    const h = walking("ask_each");
    h.command({
      type: "approve",
      proposalId: h.session.proposal?.id ?? "",
      scope: "session",
    });
    expect(h.session.state).toBe("acting");
    expect(h.session.grant).toBeNull();
  });

  test("a phone that says 'task' (built before sessions) gets a yes for this one only", () => {
    const h = proposing("ask_once_per_session");
    h.command({
      type: "approve",
      proposalId: h.session.proposal?.id ?? "",
      scope: "task",
    });
    expect(h.session.state).toBe("acting");
    expect(h.session.grant).toBeNull();
  });

  test("the session's yes stays on the site it was given on, and ends with the setting", () => {
    const h = walking();
    const id = h.session.proposal?.id ?? "";
    h.session = {
      ...h.session,
      proposal: h.session.proposal
        ? { ...h.session.proposal, seen: { url: "https://www.gov.gr/a" } }
        : null,
    };
    h.command({ type: "approve", proposalId: id, scope: "session" });
    expect(h.session.grant?.host).toBe("www.gov.gr");
    // The same site under another name, as the server names it, is covered.
    h.session = {
      ...h.session,
      grant: h.session.grant ? { ...h.session.grant, host: "gov.gr" } : null,
    };
    h.run({ type: "action.done", proposalId: id });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Here.",
      proposal: {
        ...onStep("e2"),
        seen: { url: "https://dilosi.services.gov.gr/form", site: "gov.gr" },
      },
    });
    expect(h.session.state).toBe("acting");
    h.run({ type: "action.done", proposalId: h.session.proposal?.id ?? "" });
    if (h.session.state !== "thinking") h.command({ type: "show_me" });
    // Another site: asked about.
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "There.",
      proposal: { ...onStep("e2"), seen: { url: "https://evil.example/x" } },
    });
    expect(h.session.state).toBe("awaiting_permission");
  });

  test("switching the setting to 'ask every time' stops the session's yes from covering anything", () => {
    const strict = harness("ask_each");
    const h = walking();
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "session" });
    h.run({ type: "action.done", proposalId: id });
    strict.session = h.session;
    strict.run({
      type: "brain.reply",
      thinkId: strict.session.thinkId ?? "",
      say: "Next.",
      proposal: onStep("e2"),
    });
    expect(strict.session.state).toBe("awaiting_permission");
  });

  test("the session's yes survives a new question, Show me again, Retry and a new plan", () => {
    const h = walking();
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "session" });
    h.run({ type: "action.done", proposalId: id });
    h.run({ type: "brain.reply", thinkId: h.thinking(), say: "Next." });
    h.command({ type: "ask", text: "and then?" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "New plan.",
      plan: PLAN,
    });
    h.command({ type: "show_me" });
    h.run({ type: "brain.failed", thinkId: h.thinking() });
    h.command({ type: "retry" });
    expect(h.session.grant?.scope).toBe("session");
  });

  test.each([
    { type: "stop" },
    { type: "sleep" },
    { type: "set_mode", mode: "guide" },
    { type: "activate", trigger: { kind: "takeover", requestId: "r-grant" } },
  ] as const)("$type ends the session's yes", (next) => {
    const h = walking();
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "session" });
    h.run({ type: "action.done", proposalId: id });
    h.run({ type: "brain.reply", thinkId: h.thinking(), say: "Done." });
    expect(h.session.grant).not.toBeNull();
    h.command(next);
    expect(h.session.grant).toBeNull();
  });

  test("the session's yes lapses after two hours", () => {
    const h = walking();
    h.command({
      type: "approve",
      proposalId: h.session.proposal?.id ?? "",
      scope: "session",
    });
    h.advance(CLICKY_SESSION_GRANT_TTL_MS);
    h.run({ type: "tick" });
    expect(h.session.grant).toBeNull();
  });

  test("switching Do it for me on or off is audited", () => {
    const h = harness();
    const on = h.command({ type: "set_mode", mode: "act" });
    expect(on.effects).toContainEqual(
      expect.objectContaining({
        event: "clicky.mode_changed",
        detail: expect.objectContaining({ mode: "act", from: "guide" }),
      }),
    );
    const off = h.command({ type: "set_mode", mode: "guide" });
    expect(off.effects).toContainEqual(
      expect.objectContaining({ event: "clicky.mode_changed" }),
    );
  });

  test("what was done is in the audit row, with the label the person approved", () => {
    const h = proposing();
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "once" });
    const done = h.run({
      type: "action.done",
      proposalId: id,
      detail: { role: "button", name: "Search", host: "example.com" },
    });
    expect(done.effects[0]).toMatchObject({
      event: "clicky.action_performed",
      detail: {
        proposalId: id,
        action: "click",
        label: "the search box",
        role: "button",
        name: "Search",
        host: "example.com",
      },
    });
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

  test("a click on a field to type into only starts its step; the typing's look finishes it", () => {
    // Live: "Click the address bar and type gov.gr" was finished by the click, before any typing.
    const h = harness();
    h.command({ type: "ask", text: "how do I get to gov.gr?" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Three steps.",
      plan: {
        ...PLAN,
        steps: PLAN.steps.map((step, index) =>
          index === 0 ? { ...step, typing: true } : step,
        ),
      },
    });
    expect(h.session.walkthrough?.steps[0]?.typing).toBe(true);
    expect(
      h.run({ type: "person.input", at: { x: 0.15, y: 0.12 } }).changed,
    ).toBe(false);
    expect(h.session.walkthrough?.steps[0]?.status).toBe("current");
    h.run({ type: "person.typed" });
    const look = h.session.check;
    expect(look?.stepId).toBe(h.session.walkthrough?.steps[0]?.id);
    h.run({ type: "brain.check", checkId: look?.id ?? "", stepDone: true });
    expect(h.session.walkthrough?.steps[0]?.status).toBe("done");
  });

  test("the person finishing the last step carries on: a look for the next steps, not 'that's everything'", () => {
    // Live: three steps took the person to gov.gr's documents page, short of the declaration.
    const h = harness();
    h.command({ type: "ask", text: "how do I issue a declaration?" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "One step.",
      plan: { goal: "Issue a declaration", steps: [PLAN.steps[0]!] },
    });
    const clicked = h.run({ type: "person.input", at: { x: 0.15, y: 0.12 } });
    expect(h.session.state).toBe("thinking");
    expect(h.session.lastThink?.reason).toBe("continue");
    expect(h.session.overlays).toEqual([]);
    expect(
      clicked.effects.filter((effect) => effect.type === "think"),
    ).toHaveLength(1);
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Now the service.",
      plan: { goal: "Issue a declaration", steps: [PLAN.steps[0]!] },
    });
    expect(h.session.walkthrough?.steps[0]?.status).toBe("current");
    // The look after typing finishing the last step carries on the same way.
    h.run({ type: "person.typed" });
    h.run({
      type: "brain.check",
      checkId: h.session.check?.id ?? "",
      stepDone: true,
    });
    expect(h.session.lastThink?.reason).toBe("continue");
    // The model saying the goal is reached, with no plan, ends it there.
    h.run({ type: "brain.reply", thinkId: h.thinking(), say: "Done!" });
    expect(h.session.state).not.toBe("thinking");
    expect(h.session.reply?.text).toBe("Done!");
  });

  test("a look that finds several steps done moves past all of them", () => {
    // Live: the person clicked the search box, typed and pressed Enter; the look saw results.
    const h = guided();
    h.run({ type: "person.typed" });
    h.run({
      type: "brain.check",
      checkId: h.session.check?.id ?? "",
      stepDone: true,
      stepsDone: 2,
    });
    expect(h.session.walkthrough?.steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "current",
    ]);
  });

  test("carrying on stops at the auto-step limit, with 'that's everything'", () => {
    const h = harness();
    h.command({ type: "ask", text: "how?" });
    for (let round = 0; round < 40; round += 1) {
      h.run({
        type: "brain.reply",
        thinkId: h.thinking(),
        say: "Next.",
        plan: { goal: "Somewhere", steps: [PLAN.steps[0]!] },
      });
      h.run({ type: "person.input", at: { x: 0.15, y: 0.12 } });
      if (h.session.state !== "thinking") break;
    }
    expect(h.session.reply?.notice).toBe("walkthrough_done");
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

describe("an older session, an older setting", () => {
  test("a stored session gets the new fields, and a walkthrough-bound grant is dropped", () => {
    const old = {
      ...newClickySession({ id: "s", botId: "b", now: T0 }),
      grant: {
        walkthroughId: "w1",
        grantedAt: "x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    } as unknown as ClickySession;
    for (const key of ["narrating", "check", "overlaysStale"])
      delete (old as Record<string, unknown>)[key];
    const session = normalizeClickySession(old);
    expect(session.grant).toBeNull();
    expect(session.narrating).toBe(false);
    expect(session.check).toBeNull();
    expect(session.overlaysStale).toBe(false);
  });

  test("'ask once per task' is read as 'ask once per session', which is the default", () => {
    expect(
      clickyPreferencesOf({ clickyActionPolicy: "ask_once_per_task" })
        .clickyActionPolicy,
    ).toBe("ask_once_per_session");
    expect(clickyPreferencesOf(undefined).clickyActionPolicy).toBe(
      "ask_once_per_session",
    );
  });
});

describe("showing what the Bot does", () => {
  const RECT = { x: 0.2, y: 0.3, width: 0.1, height: 0.05 };

  test("watch narrates without a model call, as a person's session", () => {
    const h = harness();
    const watched = h.command({ type: "watch" });
    expect(h.session).toMatchObject({
      awake: true,
      narrating: true,
      state: "guiding",
      mode: "guide",
      trigger: { kind: "person" },
    });
    expect(h.session.reply?.notice).toBe("watching");
    expect(watched.effects.some((effect) => effect.type === "think")).toBe(
      false,
    );
    h.run({ type: "bot.action", verb: "click", label: "Sign in", rect: RECT });
    expect(h.session.reply).toMatchObject({
      notice: "narrate_click",
      params: { label: "Sign in" },
    });
    expect(visibleOverlays(h.session).map((overlay) => overlay.kind)).toEqual([
      "highlight",
      "pointer",
    ]);
    h.run({ type: "bot.action", verb: "click" });
    expect(h.session.reply?.notice).toBe("narrate_working");
    expect(h.session.overlays).toEqual([]);
    h.run({ type: "bot.action", verb: "navigate", host: "gov.gr" });
    expect(h.session.reply).toMatchObject({
      notice: "narrate_navigate",
      params: { host: "gov.gr" },
    });
  });

  test("a control the page gave no name is 'here' beside the pointer, or the option chosen", () => {
    const h = harness();
    h.command({ type: "watch" });
    // Measured live: the-internet's drop-down and checkboxes have no accessible name.
    h.run({
      type: "bot.action",
      verb: "select",
      option: " Option 1 ",
      rect: RECT,
    });
    expect(h.session.reply).toMatchObject({
      notice: "narrate_choose",
      params: { option: "Option 1" },
    });
    h.run({ type: "bot.action", verb: "click", rect: RECT });
    expect(h.session.reply?.notice).toBe("narrate_click_here");
    h.run({ type: "bot.action", verb: "type", rect: RECT });
    expect(h.session.reply?.notice).toBe("narrate_type_here");
    // A named drop-down with no option said is still named.
    h.run({ type: "bot.action", verb: "select", label: "Country", rect: RECT });
    expect(h.session.reply).toMatchObject({
      notice: "narrate_select",
      params: { label: "Country" },
    });
    // Nothing to name and nothing to point at.
    h.run({ type: "bot.action", verb: "select" });
    expect(h.session.reply?.notice).toBe("narrate_working");
  });

  test("the Bot's actions are not shown unless narrating, nor after Stop", () => {
    const h = harness();
    h.command({ type: "wake" });
    expect(
      h.run({ type: "bot.action", verb: "click", label: "x" }).changed,
    ).toBe(false);
    h.command({ type: "watch" });
    h.command({ type: "stop" });
    expect(h.session.narrating).toBe(false);
    expect(
      h.run({ type: "bot.action", verb: "click", label: "x" }).changed,
    ).toBe(false);
  });

  test("narration starts clean: an earlier walkthrough is put away, and the person's clicks are not steps", () => {
    const h = harness();
    h.command({ type: "ask", text: "how?" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Steps.",
      plan: PLAN,
    });
    h.command({ type: "sleep" });
    h.command({ type: "watch" });
    expect(h.session.walkthrough).toBeNull();
    expect(
      h.run({ type: "person.input", at: { x: 0.15, y: 0.12 } }).changed,
    ).toBe(false);
    const stopped = harness();
    stopped.command({ type: "wake" });
    stopped.command({ type: "stop" });
    expect(stopped.command({ type: "watch" }).changed).toBe(false);
  });

  test("a question while narrating is the person's own", () => {
    const h = harness();
    h.command({ type: "watch" });
    h.command({ type: "ask", text: "what is it doing?" });
    expect(h.session.narrating).toBe(false);
    expect(h.session.state).toBe("thinking");
  });

  test("the Bot finishing ends narration with the follow-up; a person's walkthrough keeps going", () => {
    const h = harness();
    h.command({ type: "watch" });
    h.run({ type: "bot.action", verb: "click", label: "Go", rect: RECT });
    h.run({ type: "bot.finished", summary: "" });
    expect(h.session.narrating).toBe(false);
    expect(h.session.reply?.notice).toBe("follow_up");
    // Nothing left to guide: awake, not guiding, so no screen takes control for it.
    expect(h.session.state).toBe("idle");
    expect(h.session.overlays).toEqual([]);

    const g = harness();
    g.command({ type: "ask", text: "how?" });
    g.run({
      type: "brain.reply",
      thinkId: g.thinking(),
      say: "Steps.",
      plan: PLAN,
    });
    expect(g.run({ type: "bot.finished", summary: "" }).changed).toBe(false);
    expect(g.session.walkthrough?.currentStepId).not.toBeNull();
  });
});

describe("seeing the person's progress", () => {
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

  test("a page change looks again without leaving guiding, and its answer moves the step on", () => {
    const h = guided();
    const first = h.session.walkthrough?.currentStepId;
    const looked = h.run({
      type: "page.changed",
      url: "https://example.com/results",
    });
    const check = looked.effects.find((effect) => effect.type === "check");
    expect(check).toMatchObject({ type: "check", stepId: first });
    expect(h.session.state).toBe("guiding");
    expect(h.session.overlaysStale).toBe(true);
    const fresh = [
      { kind: "pointer", id: "fresh", at: { x: 0.7, y: 0.2 } },
    ] as const;
    h.run({
      type: "brain.check",
      checkId: h.session.check?.id ?? "",
      stepDone: true,
      overlays: [...fresh],
    });
    expect(h.session.walkthrough?.steps[0]?.status).toBe("done");
    expect(h.session.overlaysStale).toBe(false);
    expect(visibleOverlays(h.session)).toEqual([...fresh]);
  });

  test("an answer to another look, or about a step already finished, changes nothing twice", () => {
    const h = guided();
    h.run({ type: "person.typed" });
    expect(
      h.run({ type: "brain.check", checkId: "other", stepDone: true }).changed,
    ).toBe(false);
    const pending = h.session.check?.id ?? "";
    // The person's click finishes the step meanwhile; the look about it must not finish the next.
    h.run({ type: "person.input", at: { x: 0.15, y: 0.12 } });
    expect(h.session.walkthrough?.steps[0]?.status).toBe("done");
    const second = h.session.walkthrough?.currentStepId;
    h.run({ type: "brain.check", checkId: pending, stepDone: true });
    expect(h.session.walkthrough?.currentStepId).toBe(second);
  });

  test("a click on the target moves on and looks again for where the next step is", () => {
    const h = guided();
    const clicked = h.run({ type: "person.input", at: { x: 0.15, y: 0.12 } });
    expect(clicked.effects.some((effect) => effect.type === "check")).toBe(
      true,
    );
    expect(h.session.check?.stepId).toBe(h.session.walkthrough?.currentStepId);
  });

  test("a scroll Clicky made never finishes a step, and doing it for the person carries on", () => {
    const h = harness("ask_once_per_session");
    h.command({ type: "set_mode", mode: "act" });
    h.command({ type: "ask", text: "scroll" });
    h.run({
      type: "brain.reply",
      thinkId: h.thinking(),
      say: "Scrolling.",
      plan: PLAN,
      proposal: {
        action: {
          kind: "scroll",
          at: { x: 0.5, y: 0.5 },
          deltaY: 600,
          label: "the page",
        },
        why: "to see it",
        risk: "low",
      },
    });
    const id = h.session.proposal?.id ?? "";
    h.command({ type: "approve", proposalId: id, scope: "once" });
    const done = h.run({ type: "action.done", proposalId: id });
    expect(h.session.walkthrough?.steps[0]?.status).toBe("current");
    expect(done.effects).toContainEqual(
      expect.objectContaining({ type: "think", reason: "continue" }),
    );
  });

  test("Next and Back while a look runs put it away, so its marks never land on another step", () => {
    const h = guided();
    h.run({ type: "page.changed", url: "x" });
    const pending = h.session.check?.id ?? "";
    const moved = h.command({ type: "next" });
    expect(moved.rejected).toBeUndefined();
    expect(moved.effects).toContainEqual({ type: "cancel_check" });
    expect(h.session.check).toBeNull();
    expect(
      h.run({ type: "brain.check", checkId: pending, stepDone: false }).changed,
    ).toBe(false);
  });

  test("a look that finds nothing clears the old marks; a look that failed keeps them dimmed", () => {
    const h = guided();
    h.run({ type: "page.changed", url: "x" });
    h.run({
      type: "brain.check",
      checkId: h.session.check?.id ?? "",
      stepDone: false,
    });
    expect(visibleOverlays(h.session)).toEqual([]);
    expect(h.session.overlaysStale).toBe(false);

    const g = guided();
    g.run({ type: "page.changed", url: "x" });
    g.run({
      type: "brain.check",
      checkId: g.session.check?.id ?? "",
      stepDone: false,
      failed: true,
    });
    expect(g.session.check).toBeNull();
    expect(g.session.overlaysStale).toBe(true);
    expect(visibleOverlays(g.session).length).toBeGreaterThan(0);
  });

  test("Say that again works for a step that is shown without a reply", () => {
    const h = guided();
    h.session = { ...h.session, reply: null };
    expect(h.command({ type: "repeat" }).changed).toBe(true);
  });

  test("pausing puts a pending look away, so nothing stays dimmed after resume", () => {
    const h = guided();
    h.run({ type: "page.changed", url: "x" });
    const paused = h.command({ type: "pause" });
    expect(paused.effects).toContainEqual({ type: "cancel_check" });
    expect(h.session.check).toBeNull();
    expect(h.session.overlaysStale).toBe(false);
    h.command({ type: "resume" });
    expect(h.session.state).toBe("guiding");
  });

  test("no look while stopped, asleep, thinking or narrating", () => {
    const h = guided();
    h.command({ type: "stop" });
    expect(h.run({ type: "page.changed", url: "x" }).changed).toBe(false);
    const w = harness();
    w.command({ type: "watch" });
    expect(w.run({ type: "person.typed" }).changed).toBe(false);
    const t = harness();
    t.command({ type: "ask", text: "hm" });
    expect(t.run({ type: "person.typed" }).changed).toBe(false);
  });
});
