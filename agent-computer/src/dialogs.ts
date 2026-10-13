/**
 * JavaScript dialogs (alert, confirm, prompt, "leave this page?"), held for the Bot to answer.
 *
 * Playwright dismisses every dialog nobody listens for, so a site's "Are you sure you want to submit?"
 * was silently answered No and the Bot was left wondering why its click did nothing. Now a dialog is
 * held: the action that raised it answers with `page.dialog`, and `computer_dialog` accepts or
 * dismisses it (with the text for a prompt). One nobody answers within a minute is dismissed, as
 * before, and the next result says so, because a page that is waiting on a dialog is frozen.
 *
 * While a person holds the wheel a dialog is dismissed straight away, which is what happened before
 * this existed: the live screen cannot draw a native dialog, so holding one would freeze the page
 * under somebody who cannot see why.
 *
 * Takes the Playwright types only, so the keeper can be driven by a test's own fake dialogs.
 */
import type { BrowserContext, Dialog } from "playwright";

export type DialogInfo = {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
  /** Set when it was dismissed for nobody answering it, so there is nothing left to answer. */
  dismissed?: true;
};

/** How long a dialog is held for an answer before it is dismissed. */
export const DIALOG_HOLD_MS = 60_000;

type Held = {
  dialog: Pick<Dialog, "accept" | "dismiss">;
  info: DialogInfo;
  timer: ReturnType<typeof setTimeout>;
};

export type DialogKeeper = ReturnType<typeof createDialogKeeper>;

export function createDialogKeeper(
  options: {
    holdMs?: number;
    /** Answer dismiss at once rather than hold: a person is driving and cannot see dialogs. */
    dismissAtOnce?: (botId: string) => boolean;
  } = {},
) {
  const holdMs = options.holdMs ?? DIALOG_HOLD_MS;
  const held = new Map<string, Held>();
  const expired = new Map<string, DialogInfo>();
  const waiters = new Map<string, Set<(info: DialogInfo) => void>>();
  const leaving = new Map<string, number>();
  const attached = new WeakSet<object>();

  const infoOf = (
    dialog: Pick<Dialog, "type" | "message" | "defaultValue">,
  ) => {
    const type = dialog.type();
    const known =
      type === "alert" ||
      type === "confirm" ||
      type === "prompt" ||
      type === "beforeunload"
        ? type
        : "alert";
    const defaultValue = known === "prompt" ? dialog.defaultValue() : "";
    return {
      type: known,
      message: dialog.message().slice(0, 1_000),
      ...(defaultValue ? { defaultValue } : {}),
    } satisfies DialogInfo;
  };

  /** One dialog arriving for this Bot. Exported through `receive` so a test can feed it. */
  const receive = (
    botId: string,
    dialog: Pick<
      Dialog,
      "type" | "message" | "defaultValue" | "accept" | "dismiss"
    >,
  ) => {
    const info = infoOf(dialog);
    if (options.dismissAtOnce?.(botId)) {
      void dialog.dismiss().catch(() => undefined);
      return;
    }
    // The Bot asked to leave this page, so "Leave site?" is answered yes for it.
    if (info.type === "beforeunload" && (leaving.get(botId) ?? 0) > 0) {
      void dialog.accept().catch(() => undefined);
      return;
    }
    // A page shows one at a time; a second one means the first has gone without being answered here.
    const previous = held.get(botId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      if (held.get(botId)?.dialog !== dialog) return;
      held.delete(botId);
      expired.set(botId, { ...info, dismissed: true });
      void dialog.dismiss().catch(() => undefined);
    }, holdMs);
    timer.unref?.();
    held.set(botId, { dialog, info, timer });
    const waiting = waiters.get(botId);
    if (waiting) for (const notify of waiting) notify(info);
  };

  return {
    receive,

    /** Hold every dialog in this Bot's browser from now on. Idempotent per context. */
    attach(botId: string, context: Pick<BrowserContext, "on">): void {
      if (attached.has(context)) return;
      attached.add(context);
      context.on("dialog", (dialog) => receive(botId, dialog));
    },

    /** The dialog this Bot's page is waiting on, if any. */
    pending(botId: string): DialogInfo | undefined {
      return held.get(botId)?.info;
    },

    /**
     * Resolves with the next dialog this Bot's browser raises; `cancel` stops listening. For racing
     * an action that would otherwise wait on the frozen page until its timeout.
     */
    next(botId: string): { opened: Promise<DialogInfo>; cancel: () => void } {
      let notify: ((info: DialogInfo) => void) | undefined;
      const opened = new Promise<DialogInfo>((resolve) => {
        notify = resolve;
      });
      const set = waiters.get(botId) ?? new Set();
      waiters.set(botId, set);
      if (notify) set.add(notify);
      return {
        opened,
        cancel: () => {
          if (notify) set.delete(notify);
          if (set.size === 0) waiters.delete(botId);
        },
      };
    },

    /** Accept or dismiss the held dialog. Throws when there is none. */
    async answer(
      botId: string,
      accept: boolean,
      text?: string,
    ): Promise<DialogInfo> {
      const current = held.get(botId);
      if (!current) {
        const gone = expired.get(botId);
        throw new Error(
          gone
            ? `There is no dialog to answer: the ${gone.type} "${gone.message.slice(0, 80)}" was dismissed after a minute without an answer.`
            : "There is no dialog open on this page.",
        );
      }
      held.delete(botId);
      clearTimeout(current.timer);
      if (accept)
        await current.dialog.accept(
          current.info.type === "prompt" ? text : undefined,
        );
      else await current.dialog.dismiss();
      return current.info;
    },

    /** A dialog dismissed for nobody answering it since the last result, said once. */
    takeExpired(botId: string): DialogInfo | undefined {
      const gone = expired.get(botId);
      expired.delete(botId);
      return gone;
    },

    /** Run a navigation the Bot asked for, accepting any "leave this page?" it raises. */
    async leaving<T>(botId: string, work: () => Promise<T>): Promise<T> {
      leaving.set(botId, (leaving.get(botId) ?? 0) + 1);
      try {
        return await work();
      } finally {
        const left = (leaving.get(botId) ?? 1) - 1;
        if (left > 0) leaving.set(botId, left);
        else leaving.delete(botId);
      }
    },

    /** Drop everything held for a browser that closed: its dialogs went with it. */
    forget(botId: string): void {
      const current = held.get(botId);
      if (current) clearTimeout(current.timer);
      held.delete(botId);
      expired.delete(botId);
    },
  };
}
