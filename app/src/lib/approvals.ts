import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { i18n, msg } from "@/lib/i18n";
export type ApprovalDecision =
  | "allow_once"
  | "allow_always"
  | "deny"
  | "handled";
export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";
export type HostCommandPolicy = "ask" | "allow" | "never";
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalRuleRow = ApprovalRuleInput & { id: string };
export const BEHAVIOUR_LABELS: Record<RuleBehaviour, string> = {
  allow: msg("Take action without asking"),
  pre_approved: msg("Take action if pre-approved"),
  ask: msg("Ask before taking action"),
  hand_off: msg("Hand off to you"),
};
export type ApprovalInboxData = {
  enabled: boolean;
  requests: {
    id: string;
    status: string;
    createdAt: string;
    action: {
      botId: string;
      toolRef: string;
      effect: string;
      scope: string;
      threadId: string;
      toolCallId?: string;
      args: unknown;
      target: unknown;
      policy?: {
        behaviour: "allow" | "ask" | "hand_off" | "deny";
        source: string;
        reason: string;
      };
    };
  }[];
  rules: ApprovalRuleRow[];
  teamRules: ApprovalRuleRow[];
  preferences?: {
    enabled: boolean;
    autoReview: boolean;
    hostCommands: HostCommandPolicy;
  };
  team?: {
    enforceAutoReview: boolean;
    customRulesEnabled: boolean;
    hostCommandsCap: HostCommandPolicy;
  };
  /** The member's command policy after the team cap. */
  hostCommands?: HostCommandPolicy;
  questions: {
    id: string;
    botId: string;
    threadId: string;
    question: string;
    why?: string;
    createdAt: string;
  }[];
};
export const approvalInboxOptions = () =>
  queryOptions({
    queryKey: ["approvals"],
    queryFn: async (): Promise<ApprovalInboxData> => {
      const response = await client("/api/approvals", {
        fallback: "Your approvals could not be loaded.",
      });
      return response.json();
    },
    refetchInterval: 10_000,
  });
export const decideApproval = (id: string, decision: ApprovalDecision) =>
  client(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: { decision },
    fallback: "Your decision could not be saved.",
  });
export const revokeApprovalRule = (id: string) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "The permission could not be revoked.",
  });
export const setApprovalEnabled = (enabled: boolean) =>
  setApprovalPreferences({ enabled });
export const setApprovalPreferences = (input: {
  enabled?: boolean;
  autoReview?: boolean;
  hostCommands?: HostCommandPolicy;
}) =>
  client("/api/approvals/preferences", {
    method: "PATCH",
    body: input,
    fallback: "Your approval preference could not be saved.",
  });
export const createApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/rules", {
    method: "POST",
    body: input,
    fallback: "The rule could not be saved.",
  });
export const setTeamApprovalSettings = (input: {
  enforceAutoReview?: boolean;
  customRulesEnabled?: boolean;
  hostCommandsCap?: HostCommandPolicy;
}) =>
  client("/api/approvals/team", {
    method: "PATCH",
    body: input,
    fallback: "The team setting could not be saved.",
  });
export const createTeamApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/team/rules", {
    method: "POST",
    body: input,
    fallback: "The team rule could not be saved.",
  });
export const revokeTeamApprovalRule = (id: string) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "The team rule could not be removed.",
  });
export const answerPersonQuestion = (id: string, response: string) =>
  client(`/api/approvals/questions/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: { response },
    fallback: "Your answer could not be saved.",
  });
/**
 * Questions a Bot asked in a conversation, answered there: an option picked on the card, or words
 * typed in reply. The server closes them with that answer recorded and without resuming anything —
 * the message that answered them already started its own turn — so Approvals and the Bot's Activity
 * stop listing them as waiting.
 */
export const answerQuestionsInConversation = (input: {
  threadId: string;
  questions: string[];
  response: string;
}) =>
  client("/api/approvals/questions/answered", {
    method: "POST",
    body: input,
    fallback: "Your answer could not be recorded.",
  });
export const updateApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "The rule could not be changed.",
  });
export const updateTeamApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "The team rule could not be changed.",
  });

/**
 * A decision card a Bot's run is waiting on (`askChoice`, `askApproval`), as the server keeps it so
 * every tab can draw it and answer it. The tab running the turn opens it and heartbeats it; any tab
 * answers it; the running tab hands the answer to its run and closes it. `live` is the server's word
 * that the running tab was heard from in the last fifteen seconds. See the server's `decisions.ts`.
 */
export type WaitingDecisionKind = "choice" | "approval";
export type WaitingDecisionArgs = {
  title: string;
  summary?: string;
  options?: { id: string; label: string; description?: string }[];
  details?: { label: string; value: string }[];
  approveLabel?: string;
  rejectLabel?: string;
};
export type WaitingDecision = {
  botId: string;
  channelId: string;
  toolCallId: string;
  kind: WaitingDecisionKind;
  args: WaitingDecisionArgs;
  createdAt: string;
  heartbeatAt: string;
  live: boolean;
  answer: unknown;
  answeredAt: string | null;
  closed: boolean;
};
export const waitingDecisionKeys = {
  all: ["waiting-decisions"] as const,
  channel: (channelId: string) => ["waiting-decisions", channelId] as const,
};
/** The cards still waiting on the person in one conversation. */
export const waitingDecisionsQueryOptions = (channelId: string) =>
  queryOptions({
    queryKey: waitingDecisionKeys.channel(channelId),
    queryFn: () =>
      client<WaitingDecision[]>(
        `/api/approvals/decisions?channelId=${encodeURIComponent(channelId)}`,
        "decisions",
        { fallback: "The questions waiting on you could not be loaded." },
      ),
  });
const decisionPath = (toolCallId: string, action = "") =>
  `/api/approvals/decisions/${encodeURIComponent(toolCallId)}${action}`;
/** The record a successful decision call answers with, or nothing. Never throws. */
async function decisionFrom(response: Promise<Response>) {
  try {
    const answered = await response;
    if (!answered.ok) return null;
    const body = (await answered.json().catch(() => null)) as {
      decision?: WaitingDecision;
    } | null;
    return body?.decision ?? null;
  } catch {
    return null;
  }
}
/** Start waiting, or say this tab is still waiting. Idempotent on the server. */
export const openWaitingDecision = (input: {
  botId: string;
  channelId: string;
  toolCallId: string;
  kind: WaitingDecisionKind;
  args: WaitingDecisionArgs;
}) =>
  decisionFrom(
    tryClient("/api/approvals/decisions", { method: "POST", body: input }),
  );
export const heartbeatWaitingDecision = (toolCallId: string) =>
  decisionFrom(
    tryClient(decisionPath(toolCallId, "/heartbeat"), {
      method: "POST",
      body: {},
    }),
  );
export const readWaitingDecision = (toolCallId: string) =>
  decisionFrom(tryClient(decisionPath(toolCallId)));
/** Done with: the run has its answer, or it went as a message. Keeps the answer for a reload. */
export const closeWaitingDecision = (toolCallId: string, answer?: unknown) =>
  decisionFrom(
    tryClient(decisionPath(toolCallId, "/close"), {
      method: "POST",
      body: answer === undefined ? {} : { answer },
    }),
  );
/**
 * Answer a card whose run another tab holds. `delivered`: that tab picks it up. `stale` or
 * `missing`: no tab holds the run, so the caller sends the answer as a message. `answered`: somebody
 * already did. Throws when the server could not be reached, so the card can say so and stay open.
 */
export async function answerWaitingDecision(
  toolCallId: string,
  answer: unknown,
): Promise<"delivered" | "stale" | "missing" | "answered"> {
  const response = await tryClient(decisionPath(toolCallId, "/answer"), {
    method: "POST",
    body: { answer },
  });
  if (response.ok) return "delivered";
  if (response.status === 404) return "missing";
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    reason?: string;
  } | null;
  if (response.status === 409)
    return body?.reason === "stale" ? "stale" : "answered";
  throw new Error(body?.error ?? i18n.t("Your answer could not be sent."));
}
