import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { QuestionCard } from "@/components/chat-cards/question-card";
import { RecoveryLine } from "@/components/chat-cards/recovery-card";
import { useConversation } from "@/lib/copilot/conversation";
import { type UiStrings, useUiStrings } from "@/lib/i18n/strings";
import {
  type TeamBotConsentDecision,
  teamBotConsentMutationOptions,
} from "@/lib/team-bots";

const DECISIONS: readonly TeamBotConsentDecision[] = [
  "allow_once",
  "allow_always",
  "allow_all_team_bots",
  "skip",
];

const LABEL: Record<TeamBotConsentDecision, (ui: UiStrings) => string> = {
  allow_once: (ui) => ui.consentAllowOnce,
  allow_always: (ui) => ui.consentAllowAlways,
  allow_all_team_bots: (ui) => ui.consentAllowAllTeamBots,
  skip: (ui) => ui.consentSkip,
};

/** What happens next, said under the answer. */
const AFTER: Record<TeamBotConsentDecision, (ui: UiStrings) => string> = {
  skip: (ui) => ui.consentSkipped,
  allow_once: (ui) => ui.consentAllowedOnce,
  allow_all_team_bots: (ui) => ui.consentAllowedAllTeamBots,
  allow_always: (ui) => ui.consentAllowedAlways,
};

/**
 * The answers given in this tab, by the card they were given on.
 *
 * MODULE SCOPE, BECAUSE THE CARD DOES NOT SURVIVE. The transcript remounts its tool rows freely
 * (a refetch of history, a turn starting, the channel switching back), and an answer held in
 * component state went with every remount: the card asked again for something already decided,
 * and a second press posted the decision twice. Neither the transcript nor the server keeps the
 * answer against the call that asked (the server keeps a standing permission, not which card it
 * came from), so this tab does, keyed by the tool call when the caller knows it and by what was
 * asked otherwise. A reload forgets it, which is right: by then the Bot has been answered.
 */
const ANSWERS = new Map<
  string,
  { decision: TeamBotConsentDecision; retried?: boolean }
>();

/** Forget every remembered answer. For tests; nothing in the app needs to. */
export function forgetTeamBotConsentAnswers(): void {
  ANSWERS.clear();
}

/**
 * A Team Bot asking to use this person's own account on one server, where its owner has not
 * connected one. Allow once covers the next call, Always allow covers this Bot (or every Team Bot)
 * until cleared in Team Bots, Skip leaves it using nothing of theirs.
 *
 * The Bot has to be asked again after an Allow, so in a conversation the card offers Try again,
 * which says so as the person. Outside one (a group thread drawn without a conversation to post
 * into) it says to ask, as it always did.
 */
export function TeamBotConsentCard({
  botId,
  serverId,
  message,
  answerKey,
}: {
  botId: string;
  serverId: string;
  message: string;
  /** What the answer is remembered under: the asking tool call's id, where the caller has it. */
  answerKey?: string;
}) {
  const ui = useUiStrings();
  const conversation = useConversation();
  const key = answerKey ?? `${botId}\u0000${serverId}\u0000${message}`;
  const answer = useMutation(teamBotConsentMutationOptions());
  const [remembered, setRemembered] = useState(() => ANSWERS.get(key));
  const chosen = remembered?.decision ?? null;
  const remember = (next: {
    decision: TeamBotConsentDecision;
    retried?: boolean;
  }) => {
    ANSWERS.set(key, next);
    setRemembered(next);
  };
  const choose = (decision: TeamBotConsentDecision) =>
    answer.mutate(
      { botId, serverId, decision },
      { onSuccess: () => remember({ decision }) },
    );

  const allowed = chosen !== null && chosen !== "skip";
  const canRetry =
    allowed &&
    conversation !== null &&
    conversation.turnActive !== true &&
    remembered?.retried !== true;
  const note =
    chosen === null
      ? undefined
      : allowed && conversation === null
        ? `${AFTER[chosen](ui)} ${ui.consentAskYourself(chosen === "allow_once" ? "once" : "always")}`
        : AFTER[chosen](ui);
  const options = DECISIONS.map((id) => ({ id, label: LABEL[id](ui) }));

  return (
    <div data-team-bot-consent={serverId}>
      <QuestionCard
        answered={chosen ? { optionId: chosen, note } : undefined}
        footer={
          answer.error ? (
            <p className="text-destructive text-sm" role="alert">
              {answer.error.message}
            </p>
          ) : canRetry && conversation ? (
            <RecoveryLine
              onTryAgain={() => {
                remember({ decision: chosen, retried: true });
                void Promise.resolve(conversation.ask(ui.tryAgainMessage)).then(
                  (sent) => {
                    if (sent === false) remember({ decision: chosen });
                  },
                  () => remember({ decision: chosen }),
                );
              }}
            />
          ) : null
        }
        onPick={(option) => {
          const decision = DECISIONS.find((known) => known === option.id);
          if (decision) choose(decision);
        }}
        options={options}
        sending={
          answer.isPending && answer.variables
            ? { optionId: answer.variables.decision }
            : undefined
        }
        subtitle={message}
        title={ui.consentTitle(serverId)}
      />
    </div>
  );
}
