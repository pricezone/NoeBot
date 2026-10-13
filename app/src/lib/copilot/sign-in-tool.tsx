import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  hostOf,
  SecureFormDialog,
  SecureFormRow,
  type SecureFormState,
} from "@/components/chat-cards/secure-form";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { readSignIn, requestSignIn } from "@/lib/passwords/mutations";
import {
  FINAL_SIGN_IN,
  pendingSignInsQueryOptions,
  signInRequestQueryOptions,
} from "@/lib/passwords/queries";
import { useActiveBotHolder } from "./active-bot";
import { useFrontendTool } from "./approval-tools";
import { useComputerAvailable } from "./computer-available";

/** How long the open chat waits for the person to answer. The server's request lasts as long. */
const WAIT_MS = 15 * 60_000;
const POLL_MS = 1_500;

/** Must match SIGN_IN_TOOL_DESCRIPTION in server/src/computer/headless-tools.ts. */
const DESCRIPTION =
  "Ask the person you work for to sign you in to a website: Taxisnet and gov.gr, a bank, any login. They get a private Secure Form in this conversation (or take over the browser), and what they type goes straight into your browser by the computer. You never see the username, password or code, so do not refuse a login as too personal and never ask for credentials any other way. Open the site's sign-in page first (click its Sign in or Είσοδος button and wait for the login fields), then call this with the site's address and a short title such as 'Σύνδεση Taxisnet'. For a code that arrives later on a page of its own (an SMS confirmation), call this again on that page: it asks for the code alone. This turn pauses until they answer; you are then told only whether it worked.";

type Outcome = {
  ok?: boolean;
  signedIn?: boolean;
  site?: string;
  status?: string;
  requestId?: string;
  result?: string;
  reason?: string;
};

function parse(result: string | undefined): Outcome {
  if (!result) return {};
  try {
    const value = JSON.parse(result) as unknown;
    return value && typeof value === "object" ? (value as Outcome) : {};
  } catch {
    return {};
  }
}

/**
 * Which request each running sign-in call opened, kept outside React.
 *
 * The SDK registers a frontend tool's render once, with the closure of the render that registered it:
 * `useFrontendTool` in react-core re-registers on the tool's name and availability only. A
 * `useState` read inside that render therefore stays at its first value, the empty map. The handler
 * filled its copy, the card never saw it, and so the card never knew its request id and never drew
 * "Open private sign-in", the one thing it exists for. Nobody could reach the form from the chat, and
 * every request expired with "Nobody signed in". A store outside React, read with
 * `useSyncExternalStore` from the card component, is something a once-registered render can still
 * see change.
 */
const openedRequests = new Map<string, string>();
const openedListeners = new Set<() => void>();

function rememberOpenedRequest(toolCallId: string, requestId: string) {
  openedRequests.set(toolCallId, requestId);
  for (const listener of openedListeners) listener();
}

function forgetOpenedRequest(toolCallId: string) {
  if (!openedRequests.delete(toolCallId)) return;
  for (const listener of openedListeners) listener();
}

function subscribeToOpenedRequests(listener: () => void) {
  openedListeners.add(listener);
  return () => {
    openedListeners.delete(listener);
  };
}

/** The request a running sign-in call opened, once its handler has opened one. */
export function useOpenedSignInRequest(toolCallId: string | undefined) {
  return useSyncExternalStore(
    subscribeToOpenedRequests,
    () => (toolCallId ? openedRequests.get(toolCallId) : undefined),
    () => undefined,
  );
}

/**
 * The open chat's half of `computer_request_sign_in`.
 *
 * The handler opens the request and waits on it; the render draws a card whose button opens the
 * private form in a dialog. The form posts to the server, never into this tool call, so neither the
 * arguments nor the result the model reads ever carry a credential. An unattended turn uses the
 * headless tool of the same name, and its owner gets the form as a link on their delivery channels.
 */
export function SignInTool() {
  const bot = useActiveBotHolder();
  // A sign-in is typed into the Bot's computer; see useComputerAvailable.
  const available = useComputerAvailable();
  useFrontendTool({
    available,
    name: "computer_request_sign_in",
    description: DESCRIPTION,
    parameters: z.object({
      site: z
        .string()
        .describe("The website's address, e.g. https://example.com"),
      reason: z
        .string()
        .optional()
        .describe("Why you need to be signed in, in a few words"),
      title: z
        .string()
        .optional()
        .describe(
          "The form's title in the person's language, e.g. 'Σύνδεση Taxisnet' or 'Κωδικός SMS'",
        ),
      usernameLabel: z
        .string()
        .optional()
        .describe(
          "The username field's label as the site words it, e.g. 'Χρήστης'",
        ),
      passwordLabel: z
        .string()
        .optional()
        .describe(
          "The password field's label as the site words it, e.g. 'Κωδικός'",
        ),
      codeLabel: z
        .string()
        .optional()
        .describe(
          "For a code-only page, the code field's label, e.g. 'Κωδικός Επιβεβαίωσης'",
        ),
    }),
    handler: async (
      input: {
        site: string;
        reason?: string;
        title?: string;
        usernameLabel?: string;
        passwordLabel?: string;
        codeLabel?: string;
      },
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const asked = await requestSignIn(
        {
          botId: bot.current,
          site: input.site,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.usernameLabel
            ? { usernameLabel: input.usernameLabel }
            : {}),
          ...(input.passwordLabel
            ? { passwordLabel: input.passwordLabel }
            : {}),
          ...(input.codeLabel ? { codeLabel: input.codeLabel } : {}),
          ...(toolCall?.id ? { toolCallId: toolCall.id } : {}),
        },
        signal,
      );
      if (!asked.ok) return { ok: false, reason: asked.reason };
      const id = asked.request.id;
      // Where the card reads it from: see `openedRequests` for why not component state.
      const callId = toolCall?.id;
      if (callId) rememberOpenedRequest(callId, id);
      try {
        return await waitForSignIn(id, signal);
      } finally {
        if (callId) forgetOpenedRequest(callId);
      }
    },
    render: ({ args, result, status, toolCallId }) => (
      <SignInCard
        site={typeof args?.site === "string" ? args.site : ""}
        title={typeof args?.title === "string" ? args.title : undefined}
        toolCallId={toolCallId}
        running={status !== "complete"}
        outcome={parse(result)}
      />
    ),
  });
  return null;
}

/** Wait for the person to answer the request, as long as the server keeps it open. */
async function waitForSignIn(id: string, signal?: AbortSignal) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted)
      return {
        ok: false,
        requestId: id,
        status: "cancelled",
        result: "The request was stopped.",
      };
    const state = await readSignIn(id, signal);
    if (state && FINAL_SIGN_IN.includes(state.status))
      return {
        ok: state.status === "signed_in",
        signedIn: state.status === "signed_in",
        site: state.origin,
        status: state.status,
        requestId: id,
        result:
          state.outcome ??
          (state.status === "signed_in"
            ? `Signed in to ${state.origin}.`
            : `The sign-in to ${state.origin} did not complete.`),
        note: "You were not told the credentials and must never ask for them another way.",
      };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return {
    ok: false,
    requestId: id,
    result: "Nobody signed in. Do not ask for the login another way.",
  };
}

/** How a finished sign-in reads on its row. */
function finishedState(outcome: Outcome): SecureFormState {
  if (outcome.signedIn) return "submitted";
  if (outcome.status === "expired") return "expired";
  if (outcome.status === "cancelled") return "cancelled";
  return "failed";
}

/**
 * The sign-in in the conversation: Grok's secure form row, whose Open draws the private form in a
 * dialog with the site's icon, the Bot's title and the host the login goes to.
 */
function SignInCard({
  site,
  title,
  toolCallId,
  running,
  outcome,
}: {
  site: string;
  title?: string;
  toolCallId?: string;
  running: boolean;
  outcome: Outcome;
}) {
  const [open, setOpen] = useState(false);
  const opened = useOpenedSignInRequest(toolCallId);
  /*
   * ANY TAB, NOT ONLY THE ONE THAT ASKED. The tool call runs in one tab, and only that tab learns the
   * request's id from its handler. The person is often somewhere else: another tab, their phone, the
   * same page after a reload. There the row said "Waiting for you to sign in" with nothing to press.
   * So a running card with no id looks for it among the owner's open requests, by the call's id.
   */
  const known = outcome.requestId ?? opened;
  const pending = useQuery({
    ...pendingSignInsQueryOptions(),
    enabled: running && !known && Boolean(toolCallId),
    refetchInterval: 3_000,
  });
  const requestId =
    known ??
    pending.data?.find((candidate) => candidate.toolCallId === toolCallId)?.id;
  const request = useQuery({
    ...signInRequestQueryOptions(requestId ?? ""),
    enabled: Boolean(requestId),
  });
  const data = request.data;
  const final = data ? FINAL_SIGN_IN.includes(data.status) : false;
  // The form's own last screen says how it ended; the row says the same, so the dialog can go.
  useEffect(() => {
    if (final) setOpen(false);
  }, [final]);
  const host =
    hostOf(data?.origin) ?? hostOf(outcome.site) ?? hostOf(site) ?? site;
  const heading = title ?? data?.title ?? `Sign in to ${host}`;
  const state: SecureFormState = running
    ? requestId
      ? "open"
      : "preparing"
    : finishedState(outcome);
  const note =
    !running && !outcome.signedIn
      ? (outcome.reason ?? outcome.result)
      : undefined;
  return (
    <>
      <SecureFormRow
        icon={data?.icon}
        onOpen={() => setOpen(true)}
        state={state}
        title={heading}
      >
        {note}
      </SecureFormRow>
      {requestId ? (
        <SecureFormDialog
          icon={data?.icon}
          onOpenChange={setOpen}
          open={open}
          title={heading}
        >
          <SignInForm requestId={requestId} />
        </SecureFormDialog>
      ) : null}
    </>
  );
}

/**
 * A sign-in request drawn without its tool call: the conversation's history could not be loaded in
 * this tab (the conversation service answers 404 while another tab's run is in flight), so the call
 * that would draw the card is not here. The request is the server's, so it is drawn from that.
 */
export function SignInRequestRow({ requestId }: { requestId: string }) {
  return <SignInCard outcome={{ requestId }} running site="" />;
}
