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
            `Could not open ${hostOf(asked) ?? asked ?? "the page"}`,
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
            `Met a check on ${host ?? "the page"}`,
            text(challenge.reason) ?? reason,
          ),
        );
      }
      if (!failed) {
        steps.push({
          kind: "page",
          subject: title ?? host ?? url ?? "A page",
          output: "",
          ...(title && host ? { detail: host } : {}),
        });
      }
      return steps;
    }
    case "computer_click":
      return failed
        ? [issue("A click did not work", reason, refused)]
        : [
            {
              kind: "click",
              subject: elementOf(outcome) ?? "Something on the page",
              output: "",
            },
          ];
    case "computer_type":
      // The field, by the label the server resolved. `args` carries the text and is not read.
      return failed
        ? [issue("Could not fill in a field", reason, refused)]
        : [
            {
              kind: "type",
              subject: elementOf(outcome) ?? "A field",
              output: "",
            },
          ];
    case "computer_request_sign_in": {
      const site = text(outcome.site) ?? text(fieldsOf(args).site);
      const where = hostOf(site) ?? site ?? "the site";
      return outcome.signedIn === true
        ? [{ kind: "sign_in", subject: where, output: "" }]
        : [issue(`Not signed in to ${where}`, reason ?? text(outcome.result))];
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
    ? [issue("Asked you for help", text(fieldsOf(args).reason))]
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
