import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { createDialogKeeper } from "../src/dialogs";
import { observeAction } from "../src/observe";

/**
 * An action a dialog interrupts is stopped, not left running: the rest of it is aborted through its
 * signal and waited for, so nothing it was doing carries on after the answer has gone back (and
 * after the action lock, which waits for `settled`, is released).
 */
const page = {
  on: () => undefined,
  off: () => undefined,
  mainFrame: () => ({}),
} as unknown as Pick<Page, "on" | "off" | "mainFrame">;

const fakeDialog = {
  type: () => "alert",
  message: () => "Wait",
  defaultValue: () => "",
  accept: async () => undefined,
  dismiss: async () => undefined,
};

test("a dialog aborts the rest of the action and waits for it to wind down", async () => {
  const dialogs = createDialogKeeper();
  const steps: string[] = [];
  const observed = await observeAction(dialogs, "bot", page, async (signal) => {
    steps.push("first");
    dialogs.receive("bot", fakeDialog);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    if (signal.aborted) {
      steps.push("stopped");
      return;
    }
    steps.push("second");
  });
  expect(observed.dialog?.message).toBe("Wait");
  // Wound down before the answer: the step after the dialog never ran.
  expect(steps).toEqual(["first", "stopped"]);
  await observed.settled;
});

test("an action that will not stop is waited for only so long, and settled says when it did", async () => {
  const dialogs = createDialogKeeper();
  let finish: () => void = () => undefined;
  const started = Date.now();
  const observed = await observeAction(
    dialogs,
    "bot",
    page,
    async () => {
      dialogs.receive("bot", fakeDialog);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    50,
  );
  expect(observed.dialog).toBeDefined();
  expect(Date.now() - started).toBeLessThan(1_000);
  let done = false;
  void observed.settled.then(() => {
    done = true;
  });
  await Bun.sleep(10);
  expect(done).toBe(false);
  finish();
  await observed.settled;
  expect(done).toBe(true);
});

test("an action without a dialog answers with its value", async () => {
  const observed = await observeAction(
    createDialogKeeper(),
    "bot",
    page,
    async () => 42,
  );
  expect(observed.value).toBe(42);
  expect(observed.dialog).toBeUndefined();
});
