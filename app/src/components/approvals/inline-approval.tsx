import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  QuestionCard,
  type QuestionOption,
} from "@/components/chat-cards/question-card";
import {
  type ApprovalDecision,
  type ApprovalInboxData,
  approvalInboxOptions,
  decideApproval,
} from "@/lib/approvals";

/**
 * A decision made on a card in this conversation, kept so the card can stay drawn as answered.
 *
 * Once decided, the request leaves "pending" and the inbox stops offering it, which used to take the
 * card away the moment it was answered. What was asked and what was picked are kept here instead,
 * by tool call id, in the app's query cache rather than in the card: the transcript can remount a
 * tool's renderer as the resumed conversation streams in, and component state would not survive
 * that. Deliberately not the inbox's own record: an action a saved "always" rule let through reads
 * there exactly like one somebody allowed, and drawing an answered card for every one of those would
 * put a question in the transcript nobody was asked.
 *
 * Its own key, outside `["approvals"]`, so refreshing the inbox never clears it.
 */
type DecidedHere = Record<
  string,
  { title: string; options: QuestionOption[]; decision: ApprovalDecision }
>;
const DECIDED_HERE = ["approval-decided-here"] as const;

function useDecidedHere(): DecidedHere {
  const cache = useQueryClient();
  return (
    useQuery<DecidedHere>({
      queryKey: DECIDED_HERE,
      // Never fetched (it is written, not loaded); should anything refetch it, it keeps what it has.
      queryFn: () => cache.getQueryData<DecidedHere>(DECIDED_HERE) ?? {},
      enabled: false,
      gcTime: Number.POSITIVE_INFINITY,
    }).data ?? {}
  );
}

function rememberDecision(
  cache: QueryClient,
  toolCallId: string,
  decided: DecidedHere[string],
) {
  cache.setQueryData<DecidedHere>(DECIDED_HERE, (before) => ({
    ...before,
    [toolCallId]: decided,
  }));
}

type ApprovalRequest = ApprovalInboxData["requests"][number];

/** What the card asks, and the rows it offers, for one waiting request. */
function questionFor(request: ApprovalRequest): {
  title: string;
  options: QuestionOption[];
} {
  const handOff = request.action.policy?.behaviour === "hand_off";
  const what = request.action.toolRef
    .replace(/^computer_|^host\//, "")
    .replaceAll("_", " ");
  const choices: [ApprovalDecision, string][] = handOff
    ? [
        ["handled", "I did it myself"],
        ["deny", "Don't do it"],
      ]
    : [
        ["allow_once", "Allow once"],
        ["allow_always", "Always allow here"],
        ["deny", "Deny"],
      ];
  return {
    title: `${handOff ? "This needs you" : "Waiting for your approval"}: ${what} on ${request.action.scope}`,
    options: choices.map(([id, label]) => ({ id, label })),
  };
}

const DECISIONS = new Set<string>([
  "allow_once",
  "allow_always",
  "deny",
  "handled",
]);

/**
 * A pending approval, drawn in the conversation where the action it holds would have been.
 *
 * The same request as the Approvals page, read from the same owner-scoped inbox, so a decision made
 * in either place is the one decision. Once decided the server runs the action exactly once and
 * continues the conversation; a decision made on this card leaves the card collapsed to what was
 * picked, above the tool's own line, rather than taking it away.
 */
export function InlineApproval({
  toolCallId,
  requestId,
  fallback,
}: {
  toolCallId?: string;
  /** The request itself, for a caller that has it and may have no tool call id (`PendingRequests`). */
  requestId?: string;
  fallback: ReactNode;
}) {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const decidedHere = useDecidedHere();
  const request = requestId
    ? inbox.data?.requests.find((candidate) => candidate.id === requestId)
    : toolCallId
      ? inbox.data?.requests.find(
          (candidate) => candidate.action.toolCallId === toolCallId,
        )
      : undefined;
  const decision = useMutation({
    mutationFn: (choice: ApprovalDecision) =>
      decideApproval(request?.id ?? "", choice),
    onSuccess: (_, choice) => {
      if (toolCallId && request)
        rememberDecision(cache, toolCallId, {
          ...questionFor(request),
          decision: choice,
        });
      return cache.invalidateQueries({ queryKey: ["approvals"] });
    },
  });

  const decided = toolCallId ? decidedHere[toolCallId] : undefined;
  if (decided) {
    return (
      <>
        <QuestionCard
          answered={{ optionId: decided.decision }}
          options={decided.options}
          title={decided.title}
        />
        {fallback}
      </>
    );
  }
  if (request?.status !== "pending") return <>{fallback}</>;

  const { title, options } = questionFor(request);
  return (
    <QuestionCard
      footer={
        decision.error ? (
          <p role="alert" className="text-destructive text-sm">
            {decision.error.message}
          </p>
        ) : null
      }
      label="Waiting for your approval"
      onPick={(option) => {
        if (DECISIONS.has(option.id))
          decision.mutate(option.id as ApprovalDecision);
      }}
      options={options}
      sending={
        decision.isPending && decision.variables
          ? { optionId: decision.variables }
          : undefined
      }
      subtitle={request.action.policy?.reason}
      title={title}
    />
  );
}

/**
 * The approvals for a group of tool calls, for a transcript that draws those calls itself rather
 * than through each tool's renderer: the browser-activity group folds every click and field into
 * one collapsed line, so a card inside a step would never be seen. Drawn beside the group, outside
 * the fold, one card per waiting call — and per call decided on its card here, which stays as the
 * answered row; nothing at all when there is neither.
 */
export function PendingApprovals({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const inbox = useQuery(approvalInboxOptions());
  const decidedHere = useDecidedHere();
  const waiting = new Set(
    (inbox.data?.requests ?? [])
      .filter((request) => request.status === "pending")
      .flatMap((request) =>
        request.action.toolCallId ? [request.action.toolCallId] : [],
      ),
  );
  const ids = toolCallIds.filter((id) => waiting.has(id) || decidedHere[id]);
  if (ids.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {ids.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}
