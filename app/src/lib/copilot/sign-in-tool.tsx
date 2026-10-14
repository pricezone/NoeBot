import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  hostOf,
  SecureFormDialog,
  SecureFormRow,
  type SecureFormState,
} from "@/components/chat-cards/secure-form";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  continueSignInMutationOptions,
  readSignIn,
  requestSignIn,
} from "@/lib/passwords/mutations";
import {
  FINAL_SIGN_IN,
  pendingSignInsQueryOptions,
  signInRequestQueryOptions,
} from "@/lib/passwords/queries";
import {
  askAgainText,
  canAskAgain,
  finishedState,
  type SignInSituation,
  signInNote,
} from "@/lib/passwords/sign-in-words";
import {
  SIGN_IN_TOOL_DESCRIPTION,
  type SignInOutcome,
  signInResultForBot,
} from "../../../../shared/sign-in-guidance";
import { useActiveBotHolder } from "./active-bot";
import { useFrontendTool } from "./approval-tools";
import { useComputerAvailable } from "./computer-available";
import { useConversation } from "./conversation";

/** How long the open chat waits for the person to answer. The server's request lasts as long. */
const WAIT_MS = 15 * 60_000;
const POLL_MS = 1_500;

/** The tool result, as the row reads it. `result` is the Bot's sentence and is never shown. */
type Outcome = {
  ok?: boolean;
  signedIn?: boolean;
  site?: string;
  status?: string;
  requestId?: string;
  result?: string;
  reason?: string;
  outcome?: SignInOutcome;
  pageMessage?: string;
  movedFrom?: string;
  /** The chat stopped the request: the turn was stopped, nobody declined anything. */
  stopped?: boolean;
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
    // The same words the headless tool registers: see shared/sign-in-guidance.ts.
    description: SIGN_IN_TOOL_DESCRIPTION,
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
          "The form's title in the person's language, e.g. 'Sign in to your bank' or 'SMS code'",
        ),
      usernameLabel: z
        .string()
        .optional()
        .describe(
          "The username field's label as the site words it, e.g. 'Email' or 'Customer number'",
        ),
      passwordLabel: z
        .string()
        .optional()
        .describe(
          "The password field's label as the site words it, e.g. 'Password' or 'PIN'",
        ),
      codeLabel: z
        .string()
        .optional()
        .describe(
          "For a code-only page, the code field's label as the site words it, e.g. 'Verification code'",
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
        stopped: true,
        result: "The request was stopped.",
      };
    const state = await readSignIn(id, signal);
    // Built the way the server builds it for an unattended turn, so both tell the Bot the same.
    if (state && FINAL_SIGN_IN.includes(state.status))
      return { ...signInResultForBot(state), requestId: id };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return {
    ok: false,
    requestId: id,
    // The wait ran out with the request, so the row says Expired rather than "Not completed".
    status: "expired",
    result: "Nobody signed in. Do not ask for the login another way.",
  };
}

/**
 * The sign-in in the conversation: Grok's secure form row, whose Open draws the private form in a
 * dialog with the site's icon, the Bot's title and the host the login goes to.
 *
 * Everything on it is for the person (see sign-in-words.ts): a refused login with the site's own
 * message, Continue while the site waits for their phone, and Ask again once it ended without a
 * login going in, which says so in the conversation as them.
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [askedAgain, setAskedAgain] = useState(false);
  const conversation = useConversation();
  const queryClient = useQueryClient();
  const continueApproval = useMutation(
    continueSignInMutationOptions(queryClient),
  );
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
    // While it runs, so a refusal or a wait for the person's phone shows on the row itself.
    refetchInterval: running ? 3_000 : false,
  });
  const data = request.data;
  const final = data ? FINAL_SIGN_IN.includes(data.status) : false;
  // The form's own last screen says how it ended; the row says the same, so the dialog can go.
  useEffect(() => {
    if (final) setOpen(false);
  }, [final]);
  const host =
    hostOf(data?.origin) ?? hostOf(outcome.site) ?? hostOf(site) ?? site;
  // The server's title first: it is the Bot's, unless the login went on to another site.
  const heading = data?.title ?? title ?? t("Sign in to {{host}}", { host });
  const waiting =
    running && data?.status === "filling" && Boolean(data.approvalUntil);
  const situation: SignInSituation = running
    ? {
        ...(data?.status ? { status: data.status } : {}),
        ...(data?.attempt?.outcome ? { outcome: data.attempt.outcome } : {}),
        ...(data?.attempt?.pageMessage
          ? { pageMessage: data.attempt.pageMessage }
          : {}),
        ...(data?.movedFrom ? { movedFrom: data.movedFrom } : {}),
        waitingForApproval: waiting,
        host,
      }
    : {
        ...(outcome.status
          ? { status: outcome.status }
          : outcome.signedIn
            ? { status: "signed_in" }
            : {}),
        ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
        ...(outcome.pageMessage ? { pageMessage: outcome.pageMessage } : {}),
        ...(outcome.stopped ? { stopped: true } : {}),
        notOpened: !outcome.status && Boolean(outcome.reason),
        host,
      };
  const state: SecureFormState = running
    ? requestId
      ? "open"
      : "preparing"
    : finishedState(situation);
  const note = continueApproval.error?.message ?? signInNote(situation);
  const askAgain = !running && canAskAgain(situation) && conversation;
  return (
    <>
      <SecureFormRow
        icon={data?.icon}
        onOpen={() => {
          if (!waiting) setOpen(true);
          else if (requestId) continueApproval.mutate(requestId);
        }}
        openLabel={
          waiting
            ? continueApproval.isPending
              ? "Checking…"
              : "Continue"
            : "Open"
        }
        state={state}
        title={heading}
      >
        {note || askAgain ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {note ? <span>{note}</span> : null}
            {askAgain ? (
              <Button
                className="rounded-full"
                disabled={askedAgain}
                onClick={() => {
                  setAskedAgain(true);
                  conversation.ask(askAgainText(host));
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                {t("Ask again")}
              </Button>
            ) : null}
          </div>
        ) : null}
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
