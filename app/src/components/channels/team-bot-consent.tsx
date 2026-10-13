import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { QuestionCard } from "@/components/chat-cards/question-card";
import {
  type TeamBotConsentDecision,
  teamBotConsentMutationOptions,
} from "@/lib/team-bots";

const OPTIONS: { id: TeamBotConsentDecision; label: string }[] = [
  { id: "allow_once", label: "Allow once" },
  { id: "allow_always", label: "Always allow for this Bot" },
  { id: "allow_all_team_bots", label: "Always allow for all Team Bots" },
  { id: "skip", label: "Skip" },
];

/** What happens next, said under the answer, since the Bot has to be asked again either way. */
const AFTER: Record<TeamBotConsentDecision, string> = {
  skip: "Skipped. Nothing of yours was used.",
  allow_once: "Allowed once. Ask the Bot to try again.",
  allow_all_team_bots:
    "Always allowed for every Team Bot. Ask it to try again.",
  allow_always: "Always allowed for this Bot. Ask it to try again.",
};

/**
 * A Team Bot asking to use this person's own account on one server, where its owner has not
 * connected one. Allow once covers the next call, Always allow covers this Bot (or every Team Bot)
 * until cleared in Team Bots, Skip leaves it using nothing of theirs. The Bot is then asked again by the person.
 */
export function TeamBotConsentCard({
  botId,
  serverId,
  message,
}: {
  botId: string;
  serverId: string;
  message: string;
}) {
  const answer = useMutation(teamBotConsentMutationOptions());
  const [chosen, setChosen] = useState<TeamBotConsentDecision | null>(null);
  const choose = (decision: TeamBotConsentDecision) =>
    answer.mutate(
      { botId, serverId, decision },
      { onSuccess: () => setChosen(decision) },
    );
  return (
    <div data-team-bot-consent={serverId}>
      <QuestionCard
        answered={
          chosen ? { optionId: chosen, note: AFTER[chosen] } : undefined
        }
        footer={
          answer.error ? (
            <p className="text-destructive text-sm" role="alert">
              {answer.error.message}
            </p>
          ) : null
        }
        onPick={(option) => {
          const decision = OPTIONS.find((known) => known.id === option.id);
          if (decision) choose(decision.id);
        }}
        options={OPTIONS}
        sending={
          answer.isPending && answer.variables
            ? { optionId: answer.variables.decision }
            : undefined
        }
        subtitle={message}
        title={`Use your own ${serverId} account?`}
      />
    </div>
  );
}
