import type { Page, Response as PageResponse } from "playwright";
import type { DialogInfo, DialogKeeper } from "./dialogs";

/**
 * Run an action, stopping at a dialog it raises, and note the HTTP status of any navigation it
 * caused in the main frame.
 *
 * A page waiting on a dialog freezes the action that raised it until its own timeout, so the
 * action is raced against the dialog and left to finish (or fail) in the background once the dialog
 * is the answer.
 */
export async function observeAction<T>(
  dialogs: Pick<DialogKeeper, "next">,
  botId: string,
  target: Page,
  run: () => Promise<T>,
): Promise<{ value?: T; dialog?: DialogInfo; status?: number }> {
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
  try {
    const running = run();
    const first = await Promise.race([
      running.then((value) => ({ value })),
      watch.opened.then((dialog) => ({ dialog })),
    ]);
    if ("dialog" in first) {
      running.catch(() => undefined);
      return {
        dialog: first.dialog,
        ...(status !== undefined ? { status } : {}),
      };
    }
    return { value: first.value, ...(status !== undefined ? { status } : {}) };
  } finally {
    watch.cancel();
    target.off("response", onResponse);
  }
}
