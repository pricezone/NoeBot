/**
 * Why an action on an element did not work, said so the Bot knows what to do next.
 *
 * Playwright's own error is a sentence plus a "Call log" of everything it tried, which is noise to a
 * model and alarming to a person reading the transcript. Worse, the server used to read any error
 * mentioning the locator as "that element is not on the page any more, take a fresh snapshot", so a
 * Bot facing a cookie banner took snapshot after snapshot of a button that was there all along.
 *
 * Here the failure is told apart, with the page's own answer (`element-probe.ts`) where there is
 * one: covered (and by what, with the refs of the covering banner's buttons), disabled, not a field
 * you can type into (with the tool that fits), hidden, off-screen, gone from the page (the only one
 * that says take a new snapshot), or simply slow. No Playwright import, so this is tested without a
 * browser.
 */
import type { ElementProbe } from "./element-probe";

export type ElementProblem =
  | "covered"
  | "disabled"
  | "not_editable"
  | "not_visible"
  | "off_screen"
  | "detached"
  | "timeout"
  | "wrong_tool"
  | "invalid_value"
  | "no_such_option"
  /** `computer_dialog` with no dialog open. */
  | "no_dialog";

export type ElementProblemDetails = {
  /** What is in front of the element, and the refs of its buttons where the snapshot has them. */
  coveredBy?: {
    label: string;
    consent: boolean;
    buttons: Array<{ name: string; ref?: string }>;
  };
  /** The tool that fits this element, when the Bot used the wrong one. */
  useTool?: string;
  /** A drop-down's options, so the Bot can choose one. */
  options?: string[];
};

export type ElementProblemError = Error & {
  name: "ElementProblemError";
  problem: ElementProblem;
  details: ElementProblemDetails;
};

export function elementProblem(
  problem: ElementProblem,
  message: string,
  details: ElementProblemDetails = {},
): ElementProblemError {
  return Object.assign(new Error(message), {
    name: "ElementProblemError" as const,
    problem,
    details,
  });
}

export function isElementProblem(error: unknown): error is ElementProblemError {
  return error instanceof Error && error.name === "ElementProblemError";
}

/** A malformed acting request: the caller's mistake, answered 400. */
export function requestError(message: string): Error {
  return Object.assign(new Error(message), { name: "ActionRequestError" });
}

export function isRequestError(error: unknown): boolean {
  return error instanceof Error && error.name === "ActionRequestError";
}

/**
 * A Playwright error as one plain sentence: no "Call log", no colour codes, no API prefix.
 *
 * Used for every error this process returns, so the raw log never reaches the model or a person.
 */
export function summariseError(message: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes are control characters.
  let text = message.replace(/\u001b\[[0-9;]*m/g, "");
  const log = text.search(/\n\s*(?:Call log:|=+ logs =+)/i);
  if (log >= 0) text = text.slice(0, log);
  text = text
    .replace(
      /^(?:locator|page|frame|elementHandle|browserContext|keyboard|mouse)\.[A-Za-z]+:\s*/,
      "",
    )
    .replace(/^Error:\s*/, "")
    .trim();
  if (
    /Target page, context or browser has been closed|Target closed/i.test(text)
  )
    return "The page was closed while this was happening.";
  const firstLines = text.split("\n").slice(0, 2).join(" ").trim();
  return firstLines.length > 300 ? `${firstLines.slice(0, 299)}…` : firstLines;
}

/** The value a typed field accepts, for a field that refused a value. */
function formatOf(type: string): string | undefined {
  switch (type) {
    case "date":
      return "a date field takes YYYY-MM-DD, e.g. 2026-10-13";
    case "time":
      return "a time field takes HH:MM in 24-hour time, e.g. 14:30";
    case "datetime-local":
      return "a date-and-time field takes YYYY-MM-DDTHH:MM, e.g. 2026-10-13T14:30";
    case "month":
      return "a month field takes YYYY-MM, e.g. 2026-10";
    case "week":
      return "a week field takes YYYY-Www, e.g. 2026-W42";
    case "number":
    case "range":
      return "a number field takes digits only";
    case "color":
      return "a colour field takes #rrggbb";
    default:
      return undefined;
  }
}

const listOf = (items: readonly string[], limit = 20) =>
  items.length > limit
    ? `${items.slice(0, limit).join(" | ")} | +${items.length - limit} more`
    : items.join(" | ");

export type FailureContext = {
  error: unknown;
  /** The page's answer about the element, or null when it could not be asked (gone, or closed). */
  probe: ElementProbe | null;
  ref: string;
  /** The verb for the sentence: "click", "type into", "choose an option in". */
  verb: string;
  /** How long the action waited, for the timeout sentence. */
  timeoutMs: number;
  /** The ref the latest snapshot gave a button with this label, if it has one. */
  refFor?: (label: string) => string | undefined;
};

/** The wrong-tool answer for an element that cannot take text, or undefined if it can. */
export function notATextField(
  ref: string,
  probe: ElementProbe,
): ElementProblemError | undefined {
  if (probe.select)
    return elementProblem(
      "wrong_tool",
      `${ref} is a drop-down list, not a text field. Use computer_select with one of its options: ${listOf(probe.select.options)}.`,
      { useTool: "computer_select", options: probe.select.options },
    );
  if (probe.checkable)
    return elementProblem(
      "wrong_tool",
      `${ref} is a ${probe.type || probe.role}, not a text field. Use computer_check to tick or untick it.`,
      { useTool: "computer_check" },
    );
  if (probe.type === "file")
    return elementProblem(
      "wrong_tool",
      `${ref} is a file upload. Use computer_upload with the path of a file in your workspace.`,
      { useTool: "computer_upload" },
    );
  if (probe.readOnly)
    return elementProblem(
      "not_editable",
      `${ref} is read-only. A picker or button beside it usually fills it in (a calendar, a "Choose" button): click that instead.`,
    );
  if (probe.disabled)
    return elementProblem(
      "disabled",
      `${ref} is disabled, so nothing can be typed into it yet. It usually becomes available once an earlier field or step is done.`,
    );
  if (!probe.editable)
    return elementProblem(
      "not_editable",
      `${ref} is a ${probe.role || probe.tag}, not a field you can type into. Click it, or find the field it belongs to.`,
    );
  return undefined;
}

/** The covered answer, with the refs of the covering banner's buttons where the snapshot has them. */
function coveredBy(
  context: FailureContext,
  cover: NonNullable<ElementProbe["cover"]>,
): ElementProblemError {
  const buttons = cover.buttons.map((name) => {
    const ref = context.refFor?.(name);
    return ref ? { name, ref } : { name };
  });
  const named = buttons
    .map((button) =>
      button.ref ? `${button.ref} "${button.name}"` : `"${button.name}"`,
    )
    .join(", ");
  const missing = buttons.some((button) => !button.ref);
  const sentence = [
    `${context.ref} is covered by ${cover.label}${cover.consent ? ", a cookie or consent banner" : ""}, so the ${context.verb === "click" ? "click" : "action"} would land on that instead.`,
    named ? `Its buttons: ${named}.` : "",
    cover.consent
      ? "Nothing was clicked for you: choose one of them (rejecting optional cookies is the safe default), then try again."
      : "Finish or close it first, then try again.",
    missing && named
      ? "Take a snapshot for the refs of the ones listed without."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return elementProblem("covered", sentence, {
    coveredBy: { label: cover.label, consent: cover.consent, buttons },
  });
}

/**
 * Turn a failed action into the error the Bot should get.
 *
 * An `ElementProblemError` for anything about the element, and a plain error with a summarised
 * message for anything else (a closed page, a crash): the caller maps the first to a 422 (or a 409
 * for `detached`), the second to a 502.
 */
export function explainActionFailure(context: FailureContext): Error {
  const message =
    context.error instanceof Error
      ? context.error.message
      : String(context.error);
  const { probe, ref, verb } = context;

  if (
    /Target page, context or browser has been closed|Target closed/i.test(
      message,
    )
  )
    return new Error(summariseError(message));

  if (!probe?.connected)
    return elementProblem(
      "detached",
      `${ref} is no longer on the page: it was removed or replaced while this was happening. Take a fresh snapshot and use the refs it returns.`,
    );

  if (/Malformed value|Cannot type text into input/i.test(message)) {
    const format = formatOf(probe.type);
    return elementProblem(
      "invalid_value",
      `${ref} did not accept that value${format ? `: ${format}` : ""}.`,
    );
  }

  if (
    /Element is not an <input>|cannot be filled|element is not editable|Input of type/i.test(
      message,
    )
  ) {
    const wrong = notATextField(ref, probe);
    if (wrong) return wrong;
  }

  if (/Not a checkbox or radio button/i.test(message))
    return elementProblem(
      "wrong_tool",
      `${ref} is not a checkbox, radio button or switch. Use computer_click on it instead.`,
      { useTool: "computer_click" },
    );

  if (probe.cover) return coveredBy(context, probe.cover);

  if (probe.disabled)
    return elementProblem(
      "disabled",
      `${ref} is disabled, so it cannot be used yet. It usually becomes available once the form's required fields are filled in or an earlier step is done.`,
    );

  if (!probe.visible)
    return elementProblem(
      "not_visible",
      `${ref} is on the page but hidden. It may appear once a menu, tab or section is opened; if it is a styled checkbox or upload button, use its visible label instead.`,
    );

  const intercepted = message.match(
    /(<[a-z][^>]{0,120}>)[^\n]{0,80}?(?:from <[^>]+> subtree )?intercepts pointer events/i,
  );
  if (intercepted)
    return coveredBy(context, {
      label: intercepted[1] ?? "another element",
      text: "",
      consent: /cookie|consent|gdpr/i.test(intercepted[1] ?? ""),
      buttons: [],
    });

  if (!probe.inViewport && /viewport|scroll/i.test(message))
    return elementProblem(
      "off_screen",
      `${ref} is outside the visible area and could not be scrolled into view. Use computer_scroll with this ref, then try again.`,
    );

  if (/Timeout \d+ms exceeded/i.test(message))
    return elementProblem(
      "timeout",
      `${ref} did not become ready to ${verb} within ${Math.round(context.timeoutMs / 1000)} seconds. Read the page or take a screenshot to see what it is waiting for.`,
    );

  return new Error(summariseError(message));
}
