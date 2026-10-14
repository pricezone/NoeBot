import { i18n } from "@/lib/i18n";
import { type ComputerActivity, recordActivity } from "./activity";
import { noteComputerActivity } from "./use-computer-sleep";

/**
 * The Bot's browsing, as lines in the computer panel's Activity list.
 *
 * The list answered "what is it doing" for commands and files, and for browsing said nothing: a Bot
 * that opened a supplier's portal, clicked through to the invoices and signed in left the pane
 * empty, and the screen above it showed only where it ended up. These are the steps that get it
 * there: a page opened (its title, and its host under it), a click (on what), a field filled in
 * (which field, NEVER WHAT WENT INTO IT), a sign-in the computer typed for it, and anything that got
 * in the way, in the Bot's or the page's words.
 *
 * Read from what a tool call answered, through the one handler every computer tool runs in
 * (`approval-tools.tsx`), because a click and a typed field are carried out by the server's approval
 * gate and never reach the tool's own handler. Only the parts that are safe to put on screen are
 * read: the arguments of a typing call are not looked at at all.
 */

type Step = Omit<ComputerActivity, "id" | "at">;
type Fields = Record<string, unknown>;

const fieldsOf = (value: unknown): Fields =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The part of an address worth a line, or undefined for one that is not an address. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** The element the server resolved the ref to, by its label. Never the model's ref. */
const elementOf = (outcome: Fields): string | undefined =>
  text(fieldsOf(outcome.element).name);

function issue(
  subject: string,
  why: string | undefined,
  refused = false,
): Step {
  return {
    kind: "issue",
    subject,
    output: why ?? "",
    ...(refused ? { refused: true } : {}),
  };
}

/**
 * What any acting call's page adds: a tab it opened, a file it downloaded, a check it met.
 *
 * Read from `page` and `challenge`, which are the page's own facts, never from the arguments.
 */
function pageSteps(outcome: Fields): Step[] {
  const page = fieldsOf(outcome.page);
  const steps: Step[] = [];
  const opened = text(fieldsOf(page.opened).url);
  if (opened)
    steps.push({
      kind: "page",
      subject: text(page.title) ?? hostOf(opened) ?? opened,
      output: "",
      ...(hostOf(opened) ? { detail: `${hostOf(opened)}, in a new tab` } : {}),
    });
  const download = fieldsOf(page.download);
  const saved = text(download.path);
  if (saved)
    steps.push({
      kind: "write_file",
      subject: saved,
      output:
        typeof download.bytes === "number"
          ? `${download.bytes} bytes, downloaded`
          : "downloaded",
    });
  if (outcome.challenge)
    steps.push(
      issue(
        i18n.t("Met a check on {{host}}", {
          host:
            hostOf(text(page.url) ?? text(outcome.url)) ?? i18n.t("the page"),
        }),
        text(fieldsOf(outcome.challenge).reason),
      ),
    );
  return steps;
}

/** The fields a fill put in, by the labels the server resolved; then its click and any stop. */
function fillSteps(outcome: Fields): Step[] {
  const steps: Step[] = [];
  const filled = Array.isArray(outcome.filled) ? outcome.filled : [];
  for (const field of filled) {
    const entry = fieldsOf(field);
    steps.push({
      kind: entry.kind === "checked" ? "click" : "type",
      subject: text(fieldsOf(entry.element).name) ?? i18n.t("A field"),
      output: "",
      // A drop-down's choice is page text, not something the Bot typed.
      ...(text(entry.chosen) ? { detail: text(entry.chosen) } : {}),
    });
  }
  const refused = fieldsOf(outcome.refused);
  if (text(refused.reason))
    steps.push(
      issue(i18n.t("A field was not filled in"), text(refused.reason), true),
    );
  const failed = fieldsOf(outcome.failed);
  if (text(failed.error))
    steps.push(
      issue(i18n.t("A field could not be filled in"), text(failed.error)),
    );
  const clicked = text(fieldsOf(outcome.afterwards).clicked);
  if (clicked)
    steps.push({
      kind: "click",
      subject: i18n.t("The form's button"),
      output: "",
    });
  return steps;
}

/**
 * The lines one tool call adds, or none.
 *
 * None for a call the approval gate is holding (`waiting`), which has not happened yet and will be
 * carried out by the server, and for one somebody stopped, which is not something the Bot did.
 */
export function browsingStepsFor(
  toolName: string,
  args: unknown,
  result: unknown,
): Step[] {
  const outcome = fieldsOf(result);
  if (outcome.waiting === true || outcome.stopped === true) return [];
  const failed = outcome.ok === false;
  const refused = outcome.refused === true;
  const reason = text(outcome.reason);

  switch (toolName) {
    case "computer_navigate": {
      const asked = text(fieldsOf(args).url);
      if (failed && !outcome.challenge) {
        return [
          issue(
            i18n.t("Could not open {{host}}", {
              host: hostOf(asked) ?? asked ?? i18n.t("the page"),
            }),
            reason,
            refused,
          ),
        ];
      }
      const url = text(outcome.url) ?? asked;
      const host = hostOf(url);
      const title = text(outcome.title);
      const challenge = fieldsOf(outcome.challenge);
      const steps: Step[] = [];
      if (outcome.challenge) {
        steps.push(
          issue(
            i18n.t("Met a check on {{host}}", {
              host: host ?? i18n.t("the page"),
            }),
            text(challenge.reason) ?? reason,
          ),
        );
      }
      if (!failed) {
        steps.push({
          kind: "page",
          subject: title ?? host ?? url ?? i18n.t("A page"),
          output: "",
          ...(title && host ? { detail: host } : {}),
        });
      }
      return steps;
    }
    case "computer_click":
      return failed
        ? [issue(i18n.t("A click did not work"), reason, refused)]
        : [
            {
              kind: "click",
              subject: elementOf(outcome) ?? i18n.t("Something on the page"),
              output: "",
            },
            ...pageSteps(outcome),
          ];
    case "computer_type":
      // The field, by the label the server resolved. `args` carries the text and is not read.
      return failed
        ? [issue(i18n.t("Could not fill in a field"), reason, refused)]
        : [
            {
              kind: "type",
              subject: elementOf(outcome) ?? i18n.t("A field"),
              output: "",
            },
            ...pageSteps(outcome),
          ];
    case "computer_select":
      return failed
        ? [issue(i18n.t("Could not choose an option"), reason, refused)]
        : [
            {
              kind: "type",
              subject: elementOf(outcome) ?? i18n.t("A drop-down"),
              output: "",
              ...(text(outcome.chosen) ? { detail: text(outcome.chosen) } : {}),
            },
            ...pageSteps(outcome),
          ];
    case "computer_check":
      return failed
        ? [issue(i18n.t("Could not tick a box"), reason, refused)]
        : [
            {
              kind: "click",
              subject: elementOf(outcome) ?? i18n.t("A box"),
              output: "",
              detail: outcome.checked === false ? "unticked" : "ticked",
            },
            ...pageSteps(outcome),
          ];
    case "computer_upload":
      return failed
        ? [issue(i18n.t("Could not upload a file"), reason, refused)]
        : [
            {
              kind: "type",
              subject: elementOf(outcome) ?? i18n.t("An upload"),
              output: "",
              ...(text(outcome.path) ? { detail: text(outcome.path) } : {}),
            },
            ...pageSteps(outcome),
          ];
    case "computer_fill":
      return failed
        ? [issue(i18n.t("Could not fill in the form"), reason, refused)]
        : [...fillSteps(outcome), ...pageSteps(outcome)];
    case "computer_dialog": {
      const dialog = fieldsOf(outcome.dialog);
      return failed
        ? [issue(i18n.t("Could not answer a dialog"), reason, refused)]
        : [
            {
              kind: "click",
              subject: text(dialog.message) ?? i18n.t("A dialog"),
              output: "",
              detail: outcome.accepted === false ? "Cancel" : "OK",
            },
            ...pageSteps(outcome),
          ];
    }
    case "computer_back":
    case "computer_tabs": {
      if (failed)
        return [
          issue(
            toolName === "computer_back"
              ? i18n.t("Could not go back")
              : i18n.t("Could not switch tab"),
            reason,
            refused,
          ),
        ];
      const page = fieldsOf(outcome.page);
      const url = text(page.url);
      const title = text(page.title);
      const moved =
        toolName === "computer_back"
          ? outcome.wentBack !== false
          : typeof outcome.switched === "number" ||
            typeof outcome.closed === "number";
      return moved && (title || url)
        ? [
            {
              kind: "page",
              subject: title ?? hostOf(url) ?? url ?? i18n.t("A page"),
              output: "",
              ...(title && hostOf(url) ? { detail: hostOf(url) } : {}),
            },
          ]
        : [];
    }
    case "computer_request_sign_in": {
      const site = text(outcome.site) ?? text(fieldsOf(args).site);
      const where = hostOf(site) ?? site ?? "the site";
      return outcome.signedIn === true
        ? [{ kind: "sign_in", subject: where, output: "" }]
        : [
            issue(
              i18n.t("Not signed in to {{where}}", { where }),
              reason ?? text(outcome.result),
            ),
          ];
    }
    default:
      // A request for help is a line when it is made (`stepsWhenAsked`), not when it is answered.
      return [];
  }
}

/**
 * The lines a call adds the moment it is made, before its answer: a request for help is something
 * in the way from the moment the Bot asks, and its answer can be a long while coming.
 */
export function stepsWhenAsked(toolName: string, args: unknown): Step[] {
  return toolName === "computer_request_help"
    ? [issue(i18n.t("Asked you for help"), text(fieldsOf(args).reason))]
    : [];
}

/** Put steps in this Bot's Activity list. Never throws: it is a pane. */
function record(botId: string, steps: () => Step[]): void {
  try {
    for (const step of steps()) recordActivity(botId, step);
  } catch {
    // A step that could not be read is a line missing from a pane, not a failed tool call.
  }
}

/**
 * One tool call, run, with what it means for the computer panel around it.
 *
 * A computer tool (`computer_*`) is the Bot using its computer: a sleeping view wakes as the call
 * is made (`use-computer-sleep.ts`), and the call's browsing steps go into the Activity list, the
 * moment it is made and once it answers. Anything else just runs. Called from the one handler every
 * frontend tool goes through (`approval-tools.tsx`), which is the one place a gated click is seen.
 */
export async function observeToolCall<R>(
  botId: string,
  toolName: string,
  args: unknown,
  run: () => Promise<R>,
): Promise<R> {
  if (!toolName.startsWith("computer_")) return run();
  noteComputerActivity(botId);
  record(botId, () => stepsWhenAsked(toolName, args));
  const result = await run();
  record(botId, () => browsingStepsFor(toolName, args, result));
  return result;
}
