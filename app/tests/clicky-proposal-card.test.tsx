import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  CLICKY_ALLOW_ARM_MS,
  ClickyProposalCard,
} from "@/components/clicky/clicky-proposal-card";
import type { ClickyCommand, ClickyProposal } from "../../shared/clicky";
import type { ClickyActionPolicy } from "../../shared/user-preferences";
import { settleReactWork } from "./settle-react-work";

/**
 * "Show me how" asking before it acts. An everyday action, for somebody whose setting asks once per
 * session, offers one yes for the whole session ("Allow for this session") and Not now; somebody
 * who asked to be asked every time gets Allow once. Something hard to undo says so and is allowed
 * once at a time ("Allow"), whatever was allowed before. Not now refuses it, a request that has
 * lapsed can no longer be allowed, and the Allow button waits a moment before it takes a click.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function proposal(patch: Partial<ClickyProposal> = {}): ClickyProposal {
  return {
    id: "proposal-1",
    action: {
      kind: "click",
      at: { x: 0.5, y: 0.5 },
      label: "the Search box",
    },
    why: "That is where the order number goes.",
    risk: "low",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    ...patch,
  };
}

function draw(
  options: {
    policy?: ClickyActionPolicy | null;
    proposal?: ClickyProposal;
    armDelayMs?: number;
  } = {},
) {
  const sent: ClickyCommand[] = [];
  const view = render(
    <ClickyProposalCard
      actionPolicy={
        options.policy === undefined ? "ask_once_per_session" : options.policy
      }
      armDelayMs={options.armDelayMs ?? 0}
      busy={false}
      onCommand={(command) => sent.push(command)}
      proposal={options.proposal ?? proposal()}
      key={options.proposal?.id ?? "proposal-1"}
    />,
  );
  return { view, sent };
}

test("it says what Show me how would do and why", () => {
  const { view } = draw();
  expect(view.getByText("I'd like to")).toBeTruthy();
  expect(view.getByText("Click: the Search box")).toBeTruthy();
  expect(view.getByText("That is where the order number goes.")).toBeTruthy();
  expect(view.queryByText("Can't be undone")).toBeNull();
  expect(view.getByText(/left$/)).toBeTruthy();
});

test("an everyday action is allowed for the whole session with one yes, or not now", () => {
  const { view, sent } = draw();
  const buttons = view
    .getAllByRole("button")
    .map((button) => button.textContent);
  expect(buttons).toEqual(["Allow for this session", "Not now"]);
  fireEvent.click(view.getByRole("button", { name: "Allow for this session" }));
  expect(sent).toEqual([
    { type: "approve", proposalId: "proposal-1", scope: "session" },
  ]);
});

test("a setting saved as once per task is read as once per session", () => {
  const { view, sent } = draw({ policy: "ask_once_per_task" });
  fireEvent.click(view.getByRole("button", { name: "Allow for this session" }));
  expect(sent).toEqual([
    { type: "approve", proposalId: "proposal-1", scope: "session" },
  ]);
});

test("asking every time, only Allow once is offered", () => {
  const { view, sent } = draw({ policy: "ask_each" });
  expect(
    view.queryByRole("button", { name: "Allow for this session" }),
  ).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Allow once" }));
  expect(sent).toEqual([
    { type: "approve", proposalId: "proposal-1", scope: "once" },
  ]);
});

test("something hard to undo says so, and is allowed once at a time, even with a session's yes on offer", () => {
  const { view, sent } = draw({
    proposal: proposal({
      risk: "confirm",
      riskReason: "This sends the form.",
      action: { kind: "key", keys: "Enter", label: "Enter" },
    }),
  });
  expect(view.getByText("Can't be undone")).toBeTruthy();
  expect(view.getByText("This sends the form.")).toBeTruthy();
  expect(view.getByText("Press: Enter")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Allow for this session" }),
  ).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Allow" }));
  expect(sent).toEqual([
    { type: "approve", proposalId: "proposal-1", scope: "once" },
  ]);
});

test("Not now refuses the proposal", () => {
  const { view, sent } = draw();
  fireEvent.click(view.getByRole("button", { name: "Not now" }));
  expect(sent).toEqual([{ type: "deny", proposalId: "proposal-1" }]);
});

test("a lapsed request can no longer be allowed", () => {
  const { view } = draw({
    proposal: proposal({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  });
  expect(view.getByText("Timed out")).toBeTruthy();
  expect(
    view
      .getByRole("button", { name: "Allow for this session" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    view.getByRole("button", { name: "Not now" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("the Allow button waits a moment before it takes a click, like a permission prompt", async () => {
  const { view, sent } = draw({ armDelayMs: CLICKY_ALLOW_ARM_MS });
  const session = view.getByRole("button", { name: "Allow for this session" });
  expect(session.hasAttribute("disabled")).toBe(true);
  // Not now is never held back.
  expect(
    view.getByRole("button", { name: "Not now" }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(session);
  expect(sent).toEqual([]);

  await waitFor(() => expect(session.hasAttribute("disabled")).toBe(false), {
    timeout: 2_000,
  });
  fireEvent.click(session);
  expect(sent).toEqual([
    { type: "approve", proposalId: "proposal-1", scope: "session" },
  ]);
});

test("the countdown runs from when the request arrived, whatever the two clocks say", () => {
  // The server's clock is an hour behind this one; the request is still two minutes long.
  const serverNow = Date.now() - 60 * 60_000;
  const { view } = draw({
    proposal: proposal({
      createdAt: new Date(serverNow).toISOString(),
      expiresAt: new Date(serverNow + 120_000).toISOString(),
    }),
  });
  expect(view.getByText("2:00 left")).toBeTruthy();
  expect(view.queryByText("Timed out")).toBeNull();
});

test("before the person's setting has arrived, a session's yes is not offered", () => {
  const { view } = draw({ policy: null });
  expect(view.getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Allow for this session" }),
  ).toBeNull();
});

test("the guardrails' reason is shown as the server wrote it where there is no translation", () => {
  const { view } = draw({
    proposal: proposal({
      risk: "confirm",
      riskReason: "A sentence the catalog has never seen.",
    }),
  });
  expect(view.getByText("A sentence the catalog has never seen.")).toBeTruthy();
});

test("typing that ends with Enter says so, whatever is offered", () => {
  const typing = proposal({
    action: {
      kind: "type",
      text: "υπεύθυνη δήλωση",
      label: "the Search box",
      pressEnter: true,
    },
  });
  for (const options of [
    { policy: "ask_once_per_session" as const, proposal: typing },
    { policy: "ask_each" as const, proposal: typing },
    { policy: null, proposal: typing },
    { proposal: { ...typing, risk: "confirm" as const } },
  ]) {
    const { view } = draw(options);
    expect(
      view.getByText(
        "Type “υπεύθυνη δήλωση” into: the Search box, then press Enter",
      ),
    ).toBeTruthy();
    view.unmount();
  }
  const { view } = draw({
    proposal: proposal({
      action: { kind: "type", text: "hello", label: "the Name field" },
    }),
  });
  expect(view.getByText("Type “hello” into: the Name field")).toBeTruthy();
});
