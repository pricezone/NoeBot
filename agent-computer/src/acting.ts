/**
 * What the Bot's acting calls do to an element, one function per kind of control.
 *
 * Out of `index.ts`, which launches a browser as it is imported, so the real-browser fixture tests
 * drive exactly these functions. Playwright types only; nothing here launches anything.
 *
 * Every action goes through `guarded`, which does two things Playwright's own auto-wait does not:
 *
 *  - it gives up early on an element that is plainly blocked (disabled, hidden, or under something)
 *    for two looks in a row, rather than holding the Bot for the full action timeout, and
 *  - it explains the failure (`action-errors.ts`) instead of passing on "waiting for locator".
 *
 * And each picks the right mechanism for the control it is given: a native `<select>` is chosen
 * with `selectOption`, a custom drop-down is opened and its option clicked, a styled checkbox whose
 * real input is hidden is ticked through its label, an upload button that opens a file chooser is
 * answered with the file.
 */
import type { Locator, Page } from "playwright";
import {
  elementProblem,
  explainActionFailure,
  isElementProblem,
  notATextField,
  requestError,
} from "./action-errors";
import { type ElementProbe, probeElement } from "./element-probe";

export type ActingOptions = {
  timeoutMs: number;
  /** The caller going away: Stop, travelling from the surface. */
  signal?: AbortSignal;
  /** The ref the latest snapshot gave a button with this label, for naming a covering banner's. */
  refFor?: (label: string) => string | undefined;
};

/** How often a pending action looks at its element to see whether it is plainly blocked. */
const BLOCKED_LOOK_MS = 1_200;

/** Ask the page what the element is; null when it cannot be asked (gone, or the page frozen). */
export async function probe(locator: Locator): Promise<ElementProbe | null> {
  try {
    return await locator.evaluate(probeElement, undefined, { timeout: 1_000 });
  } catch {
    return null;
  }
}

/** Disabled, hidden or under something: the states worth giving up early on. */
const plainlyBlocked = (found: ElementProbe) =>
  found.disabled || Boolean(found.cover) || !found.visible;

/**
 * Run one Playwright action on an element, giving up early when it is plainly blocked and
 * explaining any failure.
 */
export async function guarded<T>(
  locator: Locator,
  ref: string,
  verb: string,
  options: ActingOptions,
  run: (signal: AbortSignal) => Promise<T>,
  blocks: (found: ElementProbe) => boolean = plainlyBlocked,
): Promise<T> {
  const early = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, early.signal])
    : early.signal;
  let seen: ElementProbe | undefined;
  let streak = 0;
  let looking = false;
  const watch = setInterval(() => {
    if (looking || early.signal.aborted) return;
    looking = true;
    void probe(locator)
      .then((found) => {
        if (found?.connected && blocks(found)) {
          seen = found;
          streak += 1;
          if (streak >= 2) early.abort();
        } else streak = 0;
      })
      .finally(() => {
        looking = false;
      });
  }, BLOCKED_LOOK_MS);
  try {
    return await run(signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const cutShort = early.signal.aborted;
    const found = cutShort && seen ? seen : await probe(locator);
    throw explainActionFailure({
      error: cutShort
        ? new Error(`Timeout ${options.timeoutMs}ms exceeded.`)
        : error,
      probe: found,
      ref,
      verb,
      timeoutMs: options.timeoutMs,
      ...(options.refFor ? { refFor: options.refFor } : {}),
    });
  } finally {
    clearInterval(watch);
  }
}

const listOf = (items: readonly string[]) =>
  items.length > 20
    ? `${items.slice(0, 20).join(" | ")} | +${items.length - 20} more`
    : items.join(" | ");

/** A click. A native `<select>` is refused with its options, because a click cannot choose one. */
export async function clickElement(
  locator: Locator,
  ref: string,
  role: string | undefined,
  options: ActingOptions,
): Promise<void> {
  if (role === "combobox" || role === "listbox") {
    const found = await probe(locator);
    if (found?.select)
      throw elementProblem(
        "wrong_tool",
        `${ref} is a drop-down list, and clicking it cannot choose an option here. Use computer_select with one of its options: ${listOf(found.select.options)}.`,
        { useTool: "computer_select", options: found.select.options },
      );
  }
  await guarded(locator, ref, "click", options, (signal) =>
    locator.click({ timeout: options.timeoutMs, signal }),
  );
}

export type NativeOption = { label: string; value: string; disabled: boolean };

/**
 * Which option the Bot meant: the label exactly, the value exactly, either ignoring case and
 * spacing, then the one option whose label starts with or contains what it said.
 */
export function pickOption(
  choices: readonly NativeOption[],
  wanted: string,
): NativeOption | undefined {
  const tidy = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const want = tidy(wanted);
  const exact =
    choices.find((choice) => choice.label === wanted) ??
    choices.find((choice) => choice.value === wanted) ??
    choices.find((choice) => tidy(choice.label) === want) ??
    choices.find((choice) => tidy(choice.value) === want);
  if (exact) return exact;
  if (!want) return undefined;
  const starts = choices.filter((choice) =>
    tidy(choice.label).startsWith(want),
  );
  if (starts.length === 1) return starts[0];
  const contains = choices.filter((choice) =>
    tidy(choice.label).includes(want),
  );
  return contains.length === 1 ? contains[0] : undefined;
}

/** The visible options of whatever drop-down is open on the page, for the "no such option" answer. */
async function openOptions(page: Page): Promise<string[]> {
  const texts = await page
    .getByRole("option")
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 40);
}

/** Wait briefly for an option with this label to show, exact match first. */
async function optionNamed(
  scope: Page | Locator,
  wanted: string,
  waitMs: number,
): Promise<Locator | undefined> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    for (const exact of [true, false]) {
      const option = scope.getByRole("option", { name: wanted, exact }).first();
      if (await option.isVisible().catch(() => false)) return option;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/**
 * Choose an option, by its visible label or its value.
 *
 * A native `<select>` gets `selectOption`, after checking the option exists so a typo is answered
 * with the list at once instead of a ten-second wait for an option that is never coming. Anything
 * else is a custom drop-down: opened (typed into, for an autocomplete), and its option clicked.
 */
export async function chooseOption(
  page: Page,
  locator: Locator,
  ref: string,
  wanted: string,
  options: ActingOptions,
): Promise<{ chosen: string }> {
  const found = await probe(locator);
  if (!found?.connected)
    throw explainActionFailure({
      error: new Error("detached"),
      probe: null,
      ref,
      verb: "choose an option in",
      timeoutMs: options.timeoutMs,
    });
  if (found.select) {
    const choices = await locator.evaluate((element) =>
      Array.from((element as HTMLSelectElement).options).map((option) => ({
        label: (option.label || option.text).trim(),
        value: option.value,
        disabled: option.disabled,
      })),
    );
    const match = pickOption(choices, wanted);
    const labels = choices.map((choice) => choice.label).filter(Boolean);
    if (!match)
      throw elementProblem(
        "no_such_option",
        `${ref} has no option "${wanted}". Its options: ${listOf(labels)}.`,
        { options: labels },
      );
    if (match.disabled)
      throw elementProblem(
        "disabled",
        `The option "${match.label}" in ${ref} is disabled and cannot be chosen.`,
        { options: labels },
      );
    await guarded(locator, ref, "choose an option in", options, (signal) =>
      locator.selectOption(
        { value: match.value },
        { timeout: options.timeoutMs, signal },
      ),
    );
    return { chosen: match.label };
  }

  if (found.role === "listbox") {
    const option = await optionNamed(locator, wanted, 1_500);
    if (!option)
      throw elementProblem(
        "no_such_option",
        `${ref} has no option "${wanted}". Its options: ${listOf(await openOptions(page))}.`,
      );
    await guarded(option, ref, "choose an option in", options, (signal) =>
      option.click({ timeout: options.timeoutMs, signal }),
    );
    return { chosen: wanted };
  }

  // A custom drop-down: an autocomplete is typed into, anything else is opened with a click.
  if (found.editable)
    await guarded(locator, ref, "type into", options, (signal) =>
      locator.fill(wanted, { timeout: options.timeoutMs, signal }),
    );
  else
    await guarded(locator, ref, "open", options, (signal) =>
      locator.click({ timeout: options.timeoutMs, signal }),
    );
  const option = await optionNamed(page, wanted, 2_500);
  if (!option) {
    const shown = await openOptions(page);
    throw elementProblem(
      "no_such_option",
      shown.length
        ? `${ref} opened, but has no option "${wanted}". Its options: ${listOf(shown)}.`
        : `${ref} did not show a list of options to choose from. Take a snapshot to see what opened, and click the option you want.`,
      shown.length ? { options: shown } : {},
    );
  }
  await guarded(option, ref, "choose an option in", options, (signal) =>
    option.click({ timeout: options.timeoutMs, signal }),
  );
  return { chosen: wanted };
}

/** What a Bot meant when it typed into a checkbox: yes or no, or undefined for neither. */
export function wantsTicked(text: string): boolean | undefined {
  const said = text.trim().toLowerCase();
  if (/^(true|yes|on|1|x|checked|check|tick|ticked|ναι|✓|✔)$/.test(said))
    return true;
  if (/^(false|no|off|0|unchecked|uncheck|untick|unticked|όχι|)$/.test(said))
    return false;
  return undefined;
}

/**
 * Tick or untick a checkbox, radio button or switch.
 *
 * A styled control whose real input is hidden (most of them, on modern sites) cannot be clicked
 * where it is, so its label is clicked instead, the way a person does; failing that, the input's own
 * click. Checked afterwards, because a page can untick what it does not want ticked.
 */
export async function setChecked(
  page: Page,
  locator: Locator,
  ref: string,
  checked: boolean,
  options: ActingOptions,
): Promise<void> {
  const found = await probe(locator);
  if (!found?.connected)
    throw explainActionFailure({
      error: new Error("detached"),
      probe: null,
      ref,
      verb: "tick",
      timeoutMs: options.timeoutMs,
    });
  if (found.type === "radio" && !checked)
    throw elementProblem(
      "wrong_tool",
      `${ref} is a radio button, and one cannot be unticked on its own: choose another option in its group instead.`,
    );
  if (!found.checkable && found.tag !== "label")
    throw elementProblem(
      "wrong_tool",
      `${ref} is a ${found.role || found.tag}, not a checkbox, radio button or switch. Use computer_click on it instead.`,
      { useTool: "computer_click" },
    );
  const hiddenNative =
    !found.visible && (found.type === "checkbox" || found.type === "radio");
  if (!hiddenNative) {
    await guarded(locator, ref, "tick", options, (signal) =>
      locator.setChecked(checked, { timeout: options.timeoutMs, signal }),
    );
    return;
  }
  if ((await locator.isChecked().catch(() => !checked)) === checked) return;
  // Through its label, as trusted input: a page may ignore a click made by a script.
  const marker = `openbot-label-${crypto.randomUUID()}`;
  const marked = await locator
    .evaluate((element, mark) => {
      const label = Array.from((element as HTMLInputElement).labels ?? []).find(
        (candidate) => candidate.getBoundingClientRect().width > 0,
      );
      if (!label) return false;
      label.setAttribute("data-openbot-label", mark);
      return true;
    }, marker)
    .catch(() => false);
  try {
    if (marked)
      await page.locator(`[data-openbot-label="${marker}"]`).click({
        timeout: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    else await locator.evaluate((element) => (element as HTMLElement).click());
  } catch (error) {
    throw explainActionFailure({
      error,
      probe: await probe(locator),
      ref,
      verb: "tick",
      timeoutMs: options.timeoutMs,
      ...(options.refFor ? { refFor: options.refFor } : {}),
    });
  } finally {
    if (marked)
      await page
        .locator(`[data-openbot-label="${marker}"]`)
        .evaluate((label) => label.removeAttribute("data-openbot-label"))
        .catch(() => undefined);
  }
  if ((await locator.isChecked().catch(() => checked)) !== checked)
    throw elementProblem(
      "not_editable",
      `${ref} did not stay ${checked ? "ticked" : "unticked"}: the page changed it back. Read the page for a message saying why.`,
    );
}

/**
 * Type into a field, replacing what is there; Enter afterwards when asked.
 *
 * A drop-down or a checkbox is not refused for being the wrong kind of field: the text is taken as
 * the option to choose, or as yes or no, and the result says which tool would have fitted.
 */
export async function typeInto(
  page: Page,
  locator: Locator,
  ref: string,
  text: string,
  submit: boolean,
  options: ActingOptions,
): Promise<{ routed?: "computer_select" | "computer_check"; chosen?: string }> {
  let routed: "computer_select" | "computer_check" | undefined;
  let chosen: string | undefined;
  try {
    await guarded(locator, ref, "type into", options, (signal) =>
      locator.fill(text, { timeout: options.timeoutMs, signal }),
    );
  } catch (error) {
    const tool = isElementProblem(error) ? error.details.useTool : undefined;
    if (tool === "computer_select") {
      chosen = (await chooseOption(page, locator, ref, text, options)).chosen;
      routed = tool;
    } else if (tool === "computer_check") {
      const ticked = wantsTicked(text);
      if (ticked === undefined)
        throw elementProblem(
          "wrong_tool",
          `${ref} is a checkbox. Use computer_check with checked true or false.`,
          { useTool: "computer_check" },
        );
      await setChecked(page, locator, ref, ticked, options);
      routed = tool;
    } else throw error;
  }
  if (submit && !routed)
    await guarded(locator, ref, "press Enter in", options, (signal) =>
      locator.press("Enter", { timeout: options.timeoutMs, signal }),
    );
  return {
    ...(routed ? { routed } : {}),
    ...(chosen !== undefined ? { chosen } : {}),
  };
}

/** Before typing, the wrong-kind-of-field answer without waiting, for a fill that names one. */
export async function textFieldProblem(
  locator: Locator,
  ref: string,
): Promise<Error | undefined> {
  const found = await probe(locator);
  return found ? notATextField(ref, found) : undefined;
}

/**
 * Put a workspace file into an upload control.
 *
 * A file input (or a label for one) takes the file directly, hidden or not. Anything else is
 * treated as an upload button: clicked, and the file chooser it opens is answered.
 */
export async function uploadFile(
  page: Page,
  locator: Locator,
  ref: string,
  fullPath: string,
  options: ActingOptions,
): Promise<void> {
  const found = await probe(locator);
  if (found?.type === "file" || found?.tag === "label") {
    await guarded(
      locator,
      ref,
      "upload to",
      options,
      (signal) =>
        locator.setInputFiles(fullPath, { timeout: options.timeoutMs, signal }),
      (seen) => seen.disabled,
    );
    return;
  }
  const chooser = page
    .waitForEvent("filechooser", { timeout: 4_000 })
    .catch(() => null);
  await guarded(locator, ref, "click", options, (signal) =>
    locator.click({ timeout: options.timeoutMs, signal }),
  );
  const opened = await chooser;
  if (!opened)
    throw elementProblem(
      "wrong_tool",
      `${ref} did not open a file chooser. Find the file input or the upload button it belongs to (take a snapshot) and use that ref.`,
    );
  await opened.setFiles(fullPath);
}

export async function hoverElement(
  locator: Locator,
  ref: string,
  options: ActingOptions,
): Promise<void> {
  await guarded(locator, ref, "hover over", options, (signal) =>
    locator.hover({ timeout: options.timeoutMs, signal }),
  );
}

/**
 * Scroll an element into view, or scroll inside it (or the nearest panel around it that scrolls)
 * by `deltaY`. An inner panel is how chat histories, terms-and-conditions boxes and long dropdowns
 * scroll, and a page-level wheel never moves them.
 */
export async function scrollElement(
  locator: Locator,
  ref: string,
  deltaY: number | undefined,
  options: ActingOptions,
): Promise<{ moved?: number; atEnd?: boolean; atStart?: boolean }> {
  if (deltaY === undefined) {
    await guarded(
      locator,
      ref,
      "scroll to",
      options,
      (signal) =>
        locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs, signal }),
      () => false,
    );
    return {};
  }
  try {
    return await locator.evaluate(
      (element, delta) => {
        let node: Element | null = element;
        while (node) {
          const style = getComputedStyle(node);
          if (
            /(auto|scroll|overlay)/.test(style.overflowY) &&
            node.scrollHeight > node.clientHeight
          )
            break;
          node = node.parentElement;
        }
        const panel =
          node ?? document.scrollingElement ?? document.documentElement;
        const before = panel.scrollTop;
        panel.scrollTo({ top: before + delta, behavior: "instant" });
        return {
          moved: Math.round(panel.scrollTop - before),
          atEnd: panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2,
          atStart: panel.scrollTop <= 0,
        };
      },
      deltaY,
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    throw explainActionFailure({
      error,
      probe: await probe(locator),
      ref,
      verb: "scroll",
      timeoutMs: options.timeoutMs,
    });
  }
}

export type FillField = {
  ref: string;
  text?: string;
  checked?: boolean;
  option?: string;
  file?: string;
};

export type FillThen = { click: string } | { submit: true };

/** The fields of a fill, checked: each names a ref and exactly one thing to put in it. */
export function parseFill(
  input: unknown,
  rawThen: unknown,
): { fields: FillField[]; after?: FillThen } {
  if (!Array.isArray(input) || input.length === 0 || input.length > 60)
    throw requestError("A fill needs a list of between 1 and 60 fields.");
  const fields = input.map((raw, index) => {
    const field = (raw ?? {}) as Record<string, unknown>;
    if (typeof field.ref !== "string" || !field.ref)
      throw requestError(`Field ${index} needs a ref.`);
    const given = ["text", "checked", "option", "file"].filter(
      (key) => field[key] !== undefined,
    );
    if (given.length !== 1)
      throw requestError(
        `Field ${index} (${field.ref}) needs exactly one of text, checked, option or file.`,
      );
    if (field.checked !== undefined && typeof field.checked !== "boolean")
      throw requestError(`Field ${index}: checked is true or false.`);
    for (const key of ["text", "option", "file"])
      if (field[key] !== undefined && typeof field[key] !== "string")
        throw requestError(`Field ${index}: ${key} must be text.`);
    return field as FillField;
  });
  if (rawThen === undefined) return { fields };
  const then = rawThen as Record<string, unknown> | null;
  if (typeof then?.click === "string" && then.click)
    return { fields, after: { click: then.click } };
  if (then?.submit === true) return { fields, after: { submit: true } };
  throw requestError('then is either { "click": ref } or { "submit": true }.');
}

/** What a fill did, written as it goes so an interrupted one can still say. */
export type FillOutcome = {
  filled: Array<Record<string, unknown>>;
  failed?: Record<string, unknown>;
  afterwards?: { clicked: string } | { submitted: true };
};

/**
 * Fill a whole form, field by field in the order given, through the same functions the
 * single-field tools use; then click a ref, or submit the form the last field is in.
 *
 * Stops at the first field that does not work and records which and why in `outcome.failed`,
 * keeping what was filled: the page has changed, so the Bot is told what is there rather than
 * handed an error that hides the fields that did go in.
 */
export async function fillForm(
  page: Page,
  fields: readonly FillField[],
  then: FillThen | undefined,
  deps: {
    locate: (ref: string) => Promise<Locator>;
    roleOf: (ref: string) => string | undefined;
    uploadPath: (path: string) => Promise<string>;
    failure: (error: unknown) => Record<string, unknown>;
  },
  options: ActingOptions,
  outcome: FillOutcome,
): Promise<void> {
  let last: { locator: Locator; ref: string } | undefined;
  for (const [index, field] of fields.entries()) {
    try {
      const locator = await deps.locate(field.ref);
      if (field.file !== undefined) {
        const full = await deps.uploadPath(field.file);
        await uploadFile(page, locator, field.ref, full, options);
        outcome.filled.push({ index, ref: field.ref, kind: "file" });
      } else if (field.option !== undefined) {
        const { chosen } = await chooseOption(
          page,
          locator,
          field.ref,
          field.option,
          options,
        );
        outcome.filled.push({ index, ref: field.ref, kind: "option", chosen });
      } else if (field.checked !== undefined) {
        await setChecked(page, locator, field.ref, field.checked, options);
        outcome.filled.push({
          index,
          ref: field.ref,
          kind: "checked",
          checked: field.checked,
        });
      } else {
        const text = field.text ?? "";
        const typed = await typeInto(
          page,
          locator,
          field.ref,
          text,
          false,
          options,
        );
        outcome.filled.push({
          index,
          ref: field.ref,
          kind: "text",
          characters: text.length,
          ...(typed.routed ? { routed: typed.routed } : {}),
          ...(typed.chosen !== undefined ? { chosen: typed.chosen } : {}),
        });
      }
      last = { locator, ref: field.ref };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      outcome.failed = { index, ref: field.ref, ...deps.failure(error) };
      return;
    }
  }
  if (!then) return;
  try {
    if ("click" in then) {
      const ref = then.click;
      const locator = await deps.locate(ref);
      await clickElement(locator, ref, deps.roleOf(ref), options);
      outcome.afterwards = { clicked: ref };
      return;
    }
    if (!last) return;
    const { locator, ref } = last;
    // The form's own submit (validation and the submit event, as a button press would run them);
    // Enter in the last field where there is no form, which is how script-driven forms submit.
    const submitted = await locator
      .evaluate((element) => {
        const form =
          (element as HTMLInputElement).form ?? element.closest("form");
        if (!form || typeof form.requestSubmit !== "function") return false;
        form.requestSubmit();
        return true;
      })
      .catch(() => false);
    if (!submitted)
      await guarded(locator, ref, "press Enter in", options, (signal) =>
        locator.press("Enter", { timeout: options.timeoutMs, signal }),
      );
    outcome.afterwards = { submitted: true };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    outcome.failed = {
      index: "then",
      ref: "click" in then ? then.click : last?.ref,
      ...deps.failure(error),
    };
  }
}
