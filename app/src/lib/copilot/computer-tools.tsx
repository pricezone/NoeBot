import { IconPointer } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import {
  PILL_CLASS,
  SecureField,
  SecureFormDialog,
  SecureFormRow,
  type SecureFormState,
  SecureNote,
} from "@/components/chat-cards/secure-form";
import { ScreenShown } from "@/components/chat-cards/screen-shown";
import { CommandOutput } from "@/components/computer/command-output";
import { ComputerView } from "@/components/computer/computer-view";
import { Button } from "@/components/ui/button";
import { tryClient } from "@/lib/client";
import { noteBrowsed, recordActivity } from "@/lib/computers/activity";
import { callComputer, type ToolOutcome } from "@/lib/computers/call";
import {
  type ControlState,
  declineSecret,
  readControl,
  supplySecret,
} from "@/lib/computers/control";
import {
  runBrowserRead,
  runHelpRequest,
  runNavigation,
} from "@/lib/computers/handoff";
import { showScreen } from "@/lib/computers/screen";
import { useActiveBotHolder } from "./active-bot";
import { useFrontendTool } from "./approval-tools";
import { useComputerAvailable } from "./computer-available";

/**
 * Frontend registrations for computer tools, including inline rendering and policy-refusal display.
 */

export type { ToolOutcome } from "@/lib/computers/call";
/** What every computer call returns to the model: either the result, or a reason it did not happen. */
export { callComputer } from "@/lib/computers/call";

/**
 * Secret-entry wait window. Browser takeovers use server-authoritative request state instead.
 */
const WAIT_FOR_SECRET_MS = 10 * 60_000;

/** How often the waiting handler asks whether the person has answered yet. */
const WAIT_POLL_MS = 1_000;

/** Hold the secret-entry call open until its masked prompt is answered, cancelled, or expires. */
async function waitForSecret(
  botId: string,
  done: (state: ControlState) => boolean,
  signal: AbortSignal | undefined,
  giveUpAfterMs = WAIT_FOR_SECRET_MS,
): Promise<"answered" | "gave up" | "cancelled"> {
  const deadline = Date.now() + giveUpAfterMs;
  while (Date.now() < deadline) {
    // Stop must actually stop, including out of a wait. The SDK aborts this when a person presses it.
    if (signal?.aborted) return "cancelled";
    const state = await readControl(botId).catch(() => null);
    if (state && done(state)) return "answered";
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return "gave up";
}

/** What a computer tool's render can read back out of its own result. */
type ComputerOutcome = {
  ok?: boolean;
  stopped?: boolean;
  humanHasControl?: boolean;
  entries?: unknown[];
  refused?: boolean;
  reason?: string;
  staleRefs?: boolean;
  elements?: unknown[];
  element?: { role?: string; name?: string };
  /** What a shell call reports back, so the line can show the output rather than only the command. */
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The far side cut the output short, or stopped the command. */
  truncated?: boolean;
  timedOut?: boolean;
  /** A file write. The size, never what was written. */
  bytes?: number;
  /** A file read. Named `text` on the way back and `contents` on the way in. */
  text?: string;
  /** Where a navigation landed, which is what a finished turn's screen tile remembers. */
  url?: string;
  title?: string;
};

/**
 * What a call printed, as text a person can read.
 *
 * One helper because the three surfaces this feeds all want the same thing and shape it differently:
 * a command has `stdout` and `stderr`, a file read has `contents`, a listing has `entries`. A refusal
 * carries only its reason, and that is the most useful thing on the line.
 *
 * Never guesses. Something with none of those fields gives an empty string, and the pane says the
 * call printed nothing rather than inventing a summary.
 */
export function outputOf(result: ToolOutcome): string {
  if (result.refused === true || result.ok === false) {
    return typeof result.reason === "string" ? result.reason : "";
  }

  // `text`, which is what the read route answers with. Not `contents`: that is the name on the way
  // in, and reading it back gave an empty pane for a file the Bot had just read out loud.
  if (typeof result.text === "string") return result.text;

  if (Array.isArray(result.entries)) {
    return result.entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return String(entry);
        const { path, kind, bytes } = entry as Record<string, unknown>;
        const label = String(path ?? "");
        // A trailing slash for a folder, the way a terminal marks one, so a listing of a workspace
        // full of folders does not read as a list of extensionless files.
        if (kind === "folder") return `${label}/`;
        return typeof bytes === "number" ? `${label}  ${bytes} bytes` : label;
      })
      .join("\n");
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  // Both, in the order a terminal shows them, and labelled only when there is something on stderr:
  // most commands write nothing there and a permanent empty heading is noise.
  return stderr ? `${stdout}${stdout ? "\n" : ""}${stderr}` : stdout;
}

/**
 * Parse the SDK-render result string so the transcript can distinguish success, refusal, and failure.
 */
function outcomeOf(result: string | undefined): ComputerOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ComputerOutcome)
      : {};
  } catch {
    // Runtime stringifies thrown handlers as "Error: <message>".
    return result.startsWith("Error:")
      ? { ok: false, reason: result.slice("Error:".length).trim() }
      : {};
  }
}

/**
 * The label of the element an action touched, as the gateway resolved it server-side.
 *
 * Not taken from the model's arguments: those carry only a ref. The server looked the element up in
 * the snapshot it took itself, which is the same value it wrote to the audit trail, so the transcript
 * and the audit row name the thing identically.
 */
function labelOf(result: string | undefined): string | undefined {
  const element = (outcomeOf(result) as { element?: { name?: unknown } })
    .element;
  const name = element?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * A compact transcript line that distinguishes policy refusals from ordinary failures.
 */
function ActionLine({
  label,
  detail,
  running,
  refused,
  failed,
}: {
  label: string;
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
}) {
  return (
    <ToolLine
      detail={detail}
      failed={failed}
      label={label}
      refused={refused}
      running={running}
    />
  );
}

/** Whether a result is an ordinary failure rather than a refusal, so the two can render differently. */
function didNotWork(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.refused !== true;
}

export function ComputerTools() {
  const bot = useActiveBotHolder();
  // Not offered to a Team Bot's teammates; see useComputerAvailable.
  const available = useComputerAvailable();

  useFrontendTool({
    available,
    name: "computer_navigate",
    description:
      "Open a web page on your own computer so the person can watch. Use this when asked to look " +
      "at, visit, open or check a website. Returns the page title and its readable text, so answer " +
      "from what comes back rather than telling the person to go and look.",
    parameters: z.object({
      url: z.string().describe("Full web address to open, including https://"),
    }),
    handler: async (
      { url }: { url: string },
      // Context is optional in the SDK.
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      const result = await runNavigation(computerId, url, toolCall?.id, signal);
      if (result.ok) noteBrowsed(computerId);
      return result;
    },
    render: ({ result, status, toolCallId }) => {
      /*
       * The page this turn left open, so reopening the conversation shows what it browsed rather
       * than what the Bot has open now. Only once the turn is finished: while it runs, the live
       * frames are its own.
       */
      /*
       * A RESULT IS WHAT MAKES A TURN OVER, not the status.
       *
       * A restored tool call arrives with its result already in hand and a status that is briefly
       * something other than complete, so keying on the status alone made every reopened turn look
       * like one still running: the tile polled the live screen, put today's page under yesterday's
       * answer, and only then restored the frame it should have shown from the start.
       */
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      const page =
        typeof outcome.url === "string"
          ? {
              url: outcome.url,
              ...(typeof outcome.title === "string"
                ? { title: outcome.title }
                : {}),
            }
          : undefined;
      return (
        <div className="my-2">
          <ComputerView
            computerId={bot.current}
            active={!finished}
            /*
             * FINISHED, NOT "GOT SOMEWHERE". The tile used to count a turn as history only once it
             * had a page, so a navigation that was refused, failed or stopped never settled: it kept
             * polling the live screen under a turn that was over, and offered control of it. Those
             * are the turns most worth freezing, because the thing on screen has nothing to do with
             * what the person is reading.
             */
            finished={finished}
            {...(page ? { page } : {})}
            {...(toolCallId ? { toolCallId } : {})}
          />
        </div>
      );
    },
  });

  useFrontendTool({
    available,
    name: "computer_read",
    description:
      "Read the page currently open on your computer, without opening anything. Use this after you " +
      "click something that changes the page, such as submitting a form, to find out what it now says.",
    parameters: z.object({}),
    handler: async (
      _input: Record<string, never>,
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => runBrowserRead(bot.current, "/read", toolCall?.id, signal),
    render: () => null,
  });

  useFrontendTool({
    available,
    name: "computer_snapshot",
    description:
      "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
      "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
      "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
      "that your refs are stale, the page changed: call this again and use the new refs.",
    parameters: z.object({}),
    handler: async (
      _input: Record<string, never>,
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => runBrowserRead(bot.current, "/snapshot", toolCall?.id, signal),
    // Snapshot renders a count only; navigate owns the screen view.
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const elements = Array.isArray(outcome.elements) ? outcome.elements : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label="Read the page"
          detail={
            elements.length
              ? `${elements.length} thing${elements.length === 1 ? "" : "s"} it can act on`
              : undefined
          }
        />
      );
    },
  });

  useFrontendTool({
    available,
    name: "computer_type",
    description:
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
      "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
      "Set submit to true to press Enter afterwards.",
    parameters: z.object({
      ref: z
        .string()
        .describe("Ref of the field, from your most recent snapshot"),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
      text: z.string().describe("The text to enter"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing, to submit a single-field form"),
    }),
    handler: async (
      input: {
        ref: string;
        snapshotId: number;
        text: string;
        submit?: boolean;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/type",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Filled in"
        detail={
          // Never show typed values; identify only the target field.
          labelOf(result) ??
          (typeof args?.ref === "string" ? args.ref : undefined)
        }
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    available,
    name: "computer_click",
    description:
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
      "from your most recent snapshot and the snapshotId it came from.",
    parameters: z.object({
      ref: z
        .string()
        .describe(
          "Ref of the element to click, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { ref: string; snapshotId: number },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/click",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label="Clicked"
          detail={
            // Show refusal reason instead of an internal element ref.
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : (labelOf(result) ??
                (typeof args?.ref === "string" ? args.ref : undefined))
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    available,
    name: "computer_key",
    description:
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
      "is focused, or omit the ref to press it on the page.",
    parameters: z.object({
      key: z.string().describe("Key name, such as Enter, Tab or Escape"),
      ref: z.string().optional().describe("Optional ref to press the key on"),
      snapshotId: z
        .number()
        .optional()
        .describe("The snapshotId the ref came from, required if ref is given"),
    }),
    handler: async (
      input: {
        key: string;
        ref?: string;
        snapshotId?: number;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/key",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Pressed"
        detail={typeof args?.key === "string" ? args.key : undefined}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    available,
    name: "computer_request_secret",
    description:
      "Ask the person for ONE value you must not be told: a password, a one-time code, a card number. " +
      "Focus the field first with computer_click, then call this with the ref of that field and a " +
      "short label for what you need. They type it into a masked box that goes straight to the page. " +
      "You will never see the value, and you must not ask for it any other way. Prefer this over a " +
      "full takeover when you only need one field filled in. The value is only TYPED into the field: " +
      "if the form needs submitting, do that yourself afterwards with computer_click.",
    parameters: z.object({
      label: z
        .string()
        .describe(
          "What you need, in a few words, e.g. 'the code sent to your phone'",
        ),
      ref: z
        .string()
        .describe(
          "Ref of the field it goes in, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { label: string; ref: string; snapshotId: number },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        "/control/secret",
        {
          method: "POST",
          body: input,
        },
        signal,
      );
      if (!asked.ok) return asked;

      const askedAt = new Date().toISOString();
      // Completion is `secretWanted` clearing; the value never returns to the model.
      const waited = await waitForSecret(
        botId,
        (state) => state.secretWanted === undefined,
        signal,
      );
      if (waited !== "answered")
        return {
          ok: false,
          outcome: waited === "cancelled" ? "cancelled" : "expired",
          result:
            waited === "cancelled"
              ? "The request was cancelled."
              : `Nobody entered ${input.label}. Do not ask for it another way.`,
        };
      // How it ended, from the computer's own record: the request can clear because the value landed,
      // because the person declined, because ten minutes passed, or because the field had gone. Only
      // the first is "entered"; telling the Bot otherwise had it press Submit on an empty field.
      const state = await readControl(botId).catch(() => null);
      const last =
        state?.lastSecret && state.lastSecret.at >= askedAt
          ? state.lastSecret.outcome
          : "supplied";
      return {
        ok: last === "supplied",
        outcome: last,
        result:
          last === "supplied"
            ? `The person has entered ${input.label} into the field. It was typed straight into the page and you were not told what it is.`
            : last === "field-gone"
              ? `The field had gone from the page before ${input.label} could be entered, so nothing was typed. Take a fresh snapshot, click the field again and ask again.`
              : last === "cancelled"
                ? `The person declined to enter ${input.label}. Do not ask for it another way.`
                : `Nobody entered ${input.label} in time. Do not ask for it another way.`,
      };
    },
    // In the conversation, like a sign-in: a secure form row whose Open asks for the one value.
    render: ({ args, result, status }) => (
      <SecretCard
        computerId={bot.current}
        label={typeof args?.label === "string" ? args.label : "the value"}
        result={result}
        running={status !== "complete"}
      />
    ),
  });

  /** Self-reported model declines: audit evidence, not an enforcement control. */
  useFrontendTool({
    available,
    name: "report_refusal",
    description:
      "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
      "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
      "addition to telling the person. It changes nothing about your answer; it exists so an " +
      "administrator can see what this Bot is being asked to do. Do not call it when you simply could " +
      "not do something, only when you chose not to.",
    parameters: z.object({
      reason: z
        .string()
        .describe("Why you declined, in one sentence and in your own words"),
      request: z
        .string()
        .optional()
        .describe("What you were asked to do, in a few words"),
    }),
    handler: async (
      input: { reason: string; request?: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      try {
        const response = await tryClient(
          `/api/agents/${encodeURIComponent(bot.current)}/declined`,
          { method: "POST", body: input, signal },
        );
        return response.ok
          ? "Recorded. Now tell the person what you decided and why."
          : "That could not be recorded. Tell the person what you decided anyway.";
      } catch {
        // Audit bookkeeping must not prevent the Bot from answering.
        return "That could not be recorded. Tell the person what you decided anyway.";
      }
    },
    render: () => null,
  });

  useFrontendTool({
    available,
    name: "computer_request_help",
    description:
      "Ask the person to take control of your computer and do something you cannot: sign in, enter a " +
      "password or a one-time code, or clear a CAPTCHA. Say specifically what you need done. They " +
      "will drive the browser themselves and hand it back, and you carry on in the same session. " +
      "Use this INSTEAD of giving up, and instead of ever asking them to type a password to you. " +
      "This call is the only thing that reaches them: until you make it they are not looking at the " +
      "page and have no way to help, so saying you need them to sign in, or asking whether they would " +
      "like to proceed, hands over nothing and leaves the page where it is.",
    parameters: z.object({
      reason: z
        .string()
        .describe(
          "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
        ),
    }),
    handler: async (
      input: { reason: string },
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => runHelpRequest(bot.current, input.reason, toolCall?.id, signal),
    // In the conversation as well as in the panel: the person is reading the chat, not the panel.
    render: ({ args, result, status }) => (
      <HelpCard
        computerId={bot.current}
        reason={typeof args?.reason === "string" ? args.reason : ""}
        result={result}
        running={status !== "complete"}
      />
    ),
  });

  useFrontendTool({
    available,
    name: "computer_show_screen",
    description:
      "Show the person what is on your screen right now, as a picture in this conversation. Use it " +
      "before an irreversible submit, so they decide on the preview itself, and whenever a picture " +
      "says more than a description would. The picture is for them: you do not see it, and it does " +
      "not change the page. Do NOT rebuild a page as a generated interface to show it; show it.",
    parameters: z.object({
      caption: z
        .string()
        .optional()
        .describe(
          "A few words under the picture, in the person's language, e.g. 'Προεπισκόπηση δήλωσης'",
        ),
    }),
    handler: async (
      _input: { caption?: string },
      { toolCall }: { toolCall?: { id?: string } } = {},
    ) => {
      const toolCallId = toolCall?.id;
      if (!toolCallId)
        return {
          ok: false,
          reason:
            "The screen could not be shown: this call has no id to keep the picture under.",
        };
      const shown = await showScreen(bot.current, toolCallId);
      return shown.ok
        ? {
            ok: true,
            url: shown.url,
            shown: "The person now sees a picture of this page in the chat.",
          }
        : shown;
    },
    render: ({ args, result, status, toolCallId }) => (
      <ScreenShown
        caption={typeof args?.caption === "string" ? args.caption : undefined}
        computerId={bot.current}
        result={result}
        running={status !== "complete"}
        {...(toolCallId ? { toolCallId } : {})}
      />
    ),
  });

  useFrontendTool({
    available,
    name: "computer_list_files",
    description:
      "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
      "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
      "are not sure of. Never guess a filename.",
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe("Optional folder to list. Omit for the whole workspace."),
    }),
    handler: async (input: { path?: string }) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/list", {
        method: "POST",
        body: input ?? {},
      });
      recordActivity(computerId, {
        kind: "list_files",
        subject: input?.path ?? "the workspace",
        output: outputOf(result),
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label="Listed files"
          detail={
            outcome.refused === true || didNotWork(outcome)
              ? String(outcome.reason ?? "")
              : entries.length
                ? `${entries.length} item${entries.length === 1 ? "" : "s"} in the workspace`
                : "nothing saved yet"
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    available,
    name: "computer_read_file",
    description:
      "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
      "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
      "this to pick up notes you made before.",
    parameters: z.object({
      path: z
        .string()
        .describe("Path relative to your workspace, such as notes.md"),
    }),
    handler: async (input: { path: string }) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/read", {
        method: "POST",
        body: input,
      });
      recordActivity(computerId, {
        kind: "read_file",
        subject: input.path,
        output: outputOf(result),
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label="Read file"
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    available,
    name: "computer_run_command",
    description:
      "Run a shell command on your own computer. Use this for anything the browser cannot do: " +
      "installing a tool you need, processing a file you saved, running a script. The working " +
      "directory is your workspace, so paths are relative to it and files you write here are the " +
      "same ones the file tools see. Commands run in bash, so pipes and && work. Long output is " +
      "truncated from the start, and a command that runs too long is stopped. " +
      "You are not the root user, so anything that writes outside your workspace needs sudo, " +
      "which asks for no password: installing a package is " +
      "`sudo apt-get update && sudo apt-get install -y <package>`. If sudo is refused, this " +
      "computer does not grant it, so say so rather than retrying.",
    parameters: z.object({
      command: z
        .string()
        .describe("The command to run, such as: sudo apt-get install -y jq"),
    }),
    handler: async (
      input: { command: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const computerId = bot.current;
      const result = await callComputer(
        computerId,
        "/exec",
        { method: "POST", body: input },
        signal,
      );
      /*
       * Recorded here rather than in `render`, which runs again on every re-render and would append
       * the same command each time. This is the only place that runs once per call and has both the
       * command and what it printed.
       */
      recordActivity(computerId, {
        kind: "command",
        subject: input.command,
        output: outputOf(result),
        ...(typeof result.exitCode === "number"
          ? { exitCode: result.exitCode }
          : {}),
        ...(result.refused === true ? { refused: true } : {}),
        ...(result.truncated === true ? { truncated: true } : {}),
        ...(result.timedOut === true ? { timedOut: true } : {}),
      });
      return result;
    },
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      /*
       * The command on the line, its output behind the chevron.
       *
       * The line stays one line, because a transcript of a Bot working through twenty commands is
       * unreadable if each one dumps a screenful. But the output has to be reachable: this ran on a
       * machine holding somebody's logins, and "take the model's word for what it printed" is not an
       * answer. The pane beside the screen shows the same thing without expanding anything.
       */
      const printed = outputOf(outcome as ToolOutcome);
      const exit = typeof outcome.exitCode === "number" ? outcome.exitCode : 0;
      return (
        <ToolLine
          running={status !== "complete"}
          label="Ran a command"
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.command === "string"
                ? args.command
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome) || exit !== 0}
        >
          {status === "complete" ? (
            <CommandOutput
              output={printed}
              exitCode={exit}
              truncated={outcome.truncated === true}
              timedOut={outcome.timedOut === true}
            />
          ) : null}
        </ToolLine>
      );
    },
  });

  useFrontendTool({
    available,
    name: "computer_write_file",
    description:
      "Save a file in your own workspace so you still have it later. Paths are relative to your " +
      "workspace and folders are created as needed. Set append to true to add to the end of an " +
      "existing file rather than replacing it. Text only.",
    parameters: z.object({
      path: z
        .string()
        .describe(
          "Path relative to your workspace, such as reports/august.csv",
        ),
      contents: z.string().describe("The text to save"),
      append: z
        .boolean()
        .optional()
        .describe("Add to the end of the file instead of replacing it"),
    }),
    handler: async (input: {
      path: string;
      contents: string;
      append?: boolean;
    }) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/write", {
        method: "POST",
        body: input,
      });
      /*
       * The path and the size, never the contents. A Bot may well be saving something it was told in
       * confidence, and the write route declines to echo it back for exactly that reason; putting it
       * in a pane would undo that.
       */
      recordActivity(computerId, {
        kind: "write_file",
        subject: input.path,
        output:
          result.refused === true
            ? outputOf(result)
            : typeof result.bytes === "number"
              ? `${result.bytes} bytes${input.append === true ? ", appended" : ""}`
              : "",
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label={args?.append === true ? "Added to file" : "Saved file"}
          // Show the path, never file contents.
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    available,
    name: "computer_scroll",
    description:
      "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
    parameters: z.object({
      deltaY: z
        .number()
        .optional()
        .describe("Pixels to scroll; positive is down. Defaults to 600."),
    }),
    handler: async (
      input: { deltaY?: number },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/scroll",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Scrolled"
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  return null;
}

/** A label the Bot wrote ("the code sent to your phone"), as a row title. */
function titleOf(label: string): string {
  const trimmed = label.trim();
  return trimmed
    ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
    : "A value";
}

const CODE_LIKE = /code|otp|pin|κωδικ|sms/i;

/**
 * One value the Bot must not see, asked for in the conversation: a secure form row, and a dialog with
 * the single masked field. What is typed goes to the computer's own route and into the field the Bot
 * named, never into the conversation.
 */
export function SecretCard({
  computerId,
  label,
  running,
  result,
}: {
  computerId: string;
  label: string;
  running: boolean;
  result?: string;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  let outcome: string | undefined;
  try {
    outcome = result
      ? (JSON.parse(result) as { outcome?: string }).outcome
      : undefined;
  } catch {
    outcome = undefined;
  }
  const state: SecureFormState = running
    ? "open"
    : outcome === "supplied" || outcome === undefined
      ? "submitted"
      : outcome === "cancelled"
        ? "cancelled"
        : outcome === "expired"
          ? "expired"
          : "failed";
  const title = titleOf(label);
  const kind = CODE_LIKE.test(label) ? "code" : "password";
  return (
    <>
      <SecureFormRow onOpen={() => setOpen(true)} state={state} title={title} />
      <SecureFormDialog
        onOpenChange={setOpen}
        open={open && running}
        title={title}
      >
        <form
          autoComplete="off"
          className="flex flex-col gap-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!value || sending) return;
            setSending(true);
            const sent = await supplySecret(computerId, value);
            setSending(false);
            // Cleared whatever happened, so the value is not left in the page.
            setValue("");
            setProblem(sent.ok ? null : (sent.error ?? null));
            if (sent.ok) setOpen(false);
          }}
        >
          <SecureField
            autoFocus
            kind={kind}
            label={title}
            name="secret"
            onChange={setValue}
            value={value}
          />
          <SecureNote />
          {problem ? (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <Button
              disabled={sending}
              onClick={async () => {
                const declined = await declineSecret(computerId);
                setProblem(declined.ok ? null : (declined.error ?? null));
                if (declined.ok) setOpen(false);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Decline
            </Button>
            <Button
              className={PILL_CLASS}
              disabled={!value || sending}
              type="submit"
              variant="secondary"
            >
              {sending ? "Sending…" : "Continue"}
            </Button>
          </div>
        </form>
      </SecureFormDialog>
    </>
  );
}

/**
 * The Bot asking the person to take over its browser (a CAPTCHA, a step only a person can do): the
 * same row as a secure form, whose Open goes to the Bot's screen with the wheel offered.
 */
export function HelpCard({
  computerId,
  reason,
  running,
  result,
}: {
  computerId: string;
  reason: string;
  running: boolean;
  result?: string;
}) {
  const navigate = useNavigate();
  let ok: boolean | undefined;
  try {
    ok = result ? (JSON.parse(result) as { ok?: boolean }).ok : undefined;
  } catch {
    ok = undefined;
  }
  return (
    <SecureFormRow
      doneLabel="Handed back"
      fallbackIcon={<IconPointer className="size-5" />}
      onOpen={() =>
        void navigate({
          to: "/bot",
          search: { agent: computerId, watch: true },
        })
      }
      openLabel="Open screen"
      state={running ? "open" : ok === false ? "failed" : "submitted"}
      subtitle="Take over the browser"
      title={reason || "Your Bot needs you on its screen"}
    />
  );
}
