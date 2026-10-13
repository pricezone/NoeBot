import type { Page, Response as PageResponse } from "playwright";
import type { DialogInfo, DialogKeeper } from "./dialogs";
import { settleWithin } from "./env";

/** How long a response waits for an action a dialog interrupted to wind down. */
const INTERRUPTED_SETTLE_MS = 3_000;

/**
 * Run an action, stopping at a dialog it raises, and note the HTTP status of any navigation it
 * caused in the main frame.
 *
 * A page waiting on a dialog freezes the action that raised it until its own timeout, so the action
 * is raced against the dialog. When the dialog wins, the rest of the action is aborted through the
 * signal `run` was handed (a fill stops before its next field and its submit) and waited for, so
 * nothing it was doing carries on after the answer has gone back: not after the person has taken
 * the wheel, and not after Stop. `settled` is when it actually finished, which is what the caller
 * holds the action lock until.
 */
export async function observeAction<T>(
  dialogs: Pick<DialogKeeper, "next">,
  botId: string,
  target: Pick<Page, "on" | "off" | "mainFrame">,
  run: (signal: AbortSignal) => Promise<T>,
  settleMs = INTERRUPTED_SETTLE_MS,
): Promise<{
  value?: T;
  dialog?: DialogInfo;
  status?: number;
  settled: Promise<void>;
}> {
  let status: number | undefined;
  const onResponse = (response: PageResponse) => {
    try {
      if (
        response.request().isNavigationRequest() &&
        response.frame() === target.mainFrame()
      )
        status = response.status();
    } catch {
      // A response from a frame that has gone says nothing about this page.
    }
  };
  target.on("response", onResponse);
  const watch = dialogs.next(botId);
  const interrupt = new AbortController();
  try {
    const running = run(interrupt.signal);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    const first = await Promise.race([
      running.then((value) => ({ value })),
      watch.opened.then((dialog) => ({ dialog })),
    ]);
    if ("dialog" in first) {
      interrupt.abort(new Error("A dialog opened."));
      await settleWithin(settled, settleMs);
      return {
        dialog: first.dialog,
        ...(status !== undefined ? { status } : {}),
        settled,
      };
    }
    return {
      value: first.value,
      ...(status !== undefined ? { status } : {}),
      settled,
    };
  } finally {
    watch.cancel();
    target.off("response", onResponse);
  }
}
