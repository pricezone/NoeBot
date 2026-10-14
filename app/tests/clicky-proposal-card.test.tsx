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
 * Clicky asking before it acts. Allow once is always offered; Allow for this task only for a
 * low-risk action and only for somebody whose setting lets one yes cover a task; something hard to
 * undo says so. Not now refuses it, and a request that has lapsed can no longer be allowed.
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
        options.policy === undefined ? "ask_once_per_task" : options.policy
      }
      armDelayMs={options.armDelayMs ?? 0}
      busy={false}
      onCommand={(command) => sent.push(command)}
      proposal={options.proposal ?? proposal()}
    />,
  );
  return { view, sent };
}

test("it says what Clicky would do and why", () => {
  const { view } = draw();
  expect(view.getByText("Click: the Search box")).toBeTruthy();
  expect(view.getByText("That is where the order number goes.")).toBeTruthy();
  expect(view.queryByText("Can't be undone")).toBeNull();
  expect(view.getByText(/left$/)).toBeTruthy();
});

test("Allow for this task is offered for a low-risk action when one yes may cover a task", () => {
  const { view, sent } = draw();
  view.getByRole("button", { name: "Allow for this task" }).click();
  expect(sent).toEqual([
    { type: "approve", proposalId: "proposal-1", scope: "task" },
  ]);
});

test("asking every time, only Allow once is offered", () => {
  const { view } = draw({ policy: "ask_each" });
  expect(view.getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Allow for this task" }),
  ).toBeNull();
});

test("something hard to undo says so, and is asked about once at a time", () => {
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
    view.queryByRole("button", { name: "Allow for this task" }),
  ).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Allow once" }));
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
    view.getByRole("button", { name: "Allow once" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    view
      .getByRole("button", { name: "Allow for this task" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    view.getByRole("button", { name: "Not now" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("the Allow buttons wait a moment before they take a click, like a permission prompt", async () => {
  const { view, sent } = draw({ armDelayMs: CLICKY_ALLOW_ARM_MS });
  const once = view.getByRole("button", { name: "Allow once" });
  const task = view.getByRole("button", { name: "Allow for this task" });
  expect(once.hasAttribute("disabled")).toBe(true);
  expect(task.hasAttribute("disabled")).toBe(true);
  // Not now is never held back.
  expect(
    view.getByRole("button", { name: "Not now" }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(once);
  expect(sent).toEqual([]);

  await waitFor(() => expect(once.hasAttribute("disabled")).toBe(false), {
    timeout: 2_000,
  });
  fireEvent.click(once);
  expect(sent).toEqual([
    { type: "approve", proposalId: "proposal-1", scope: "once" },
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

test("before the person's setting has arrived, Allow for this task is not offered", () => {
  const { view } = draw({ policy: null });
  expect(view.getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Allow for this task" }),
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
