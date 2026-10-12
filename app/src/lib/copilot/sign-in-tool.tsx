import { IconLock } from "@tabler/icons-react";
import { useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { readSignIn, requestSignIn } from "@/lib/passwords/mutations";
import { FINAL_SIGN_IN } from "@/lib/passwords/queries";
import { useActiveBotHolder } from "./active-bot";
import { useFrontendTool } from "./approval-tools";
import { useComputerAvailable } from "./computer-available";

/** How long the open chat waits for the person to answer. The server's request lasts as long. */
const WAIT_MS = 15 * 60_000;
const POLL_MS = 1_500;

/** Must match SIGN_IN_TOOL_DESCRIPTION in server/src/computer/headless-tools.ts. */
const DESCRIPTION =
  "Ask the person you work for to sign you in to a website. They get a private sign-in form outside this conversation (or take over the browser), and their login is typed straight into your browser by the computer. You never see the username, password or code, and must never ask for them any other way. Open the site's sign-in page first, then call this with the site's address. This turn pauses until they answer; you are then told only whether it worked.";

type Outcome = {
  ok?: boolean;
  signedIn?: boolean;
  site?: string;
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
    }),
    handler: async (
      input: { site: string; reason?: string },
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
        result: "The request was stopped.",
      };
    const state = await readSignIn(id, signal);
    if (state && FINAL_SIGN_IN.includes(state.status))
      return {
        ok: state.status === "signed_in",
        signedIn: state.status === "signed_in",
        site: state.origin,
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

function SignInCard({
  site,
  toolCallId,
  running,
  outcome,
}: {
  site: string;
  toolCallId?: string;
  running: boolean;
  outcome: Outcome;
}) {
  const [open, setOpen] = useState(false);
  const opened = useOpenedSignInRequest(toolCallId);
  const requestId = outcome.requestId ?? opened;
  return (
    <div className="flex flex-col gap-2">
      <ToolLine
        label={
          running
            ? "Waiting for you to sign in"
            : outcome.signedIn
              ? "Signed in"
              : "Sign-in did not complete"
        }
        detail={site}
        running={running}
        failed={!running && !outcome.signedIn}
      >
        {!running && (outcome.result ?? outcome.reason) ? (
          <p className="text-muted-foreground text-sm">
            {outcome.result ?? outcome.reason}
          </p>
        ) : undefined}
      </ToolLine>
      {/* Outside the line, so the one thing the person must do is not behind a disclosure. */}
      {running && requestId ? (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            <IconLock />
            Open private sign-in
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Sign in to {site}</DialogTitle>
                <DialogDescription>
                  Goes to your Bot's browser, not into this conversation.
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="mt-4 overflow-y-auto">
                <SignInForm requestId={requestId} />
              </DialogBody>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}
