import { useRenderTool } from "@copilotkit/react-core/v2";
import { useState } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { ChoiceCard } from "@/components/gallery/decisions";
import { useConversation } from "@/lib/copilot/conversation";
import { PUT_TO } from "@/lib/copilot/markers";
import { saidItWentAhead } from "@/lib/plugins/tool-result";

/**
 * How a Bot stopping to ask a person reads in the transcript.
 *
 * RENDER ONLY, for the same reason as the handoff beside it: `ask_person` runs on the server, where
 * the route and the audit row are. What this adds is that the choice is legible. A Bot which decided
 * it could not settle something on its own, and said so rather than guessing, has done the right
 * thing; drawn as a raw `ask_person` call with its arguments as JSON it reads as a malfunction.
 */
const parameters = z.object({
  question: z.string().optional(),
  why: z.string().optional(),
  options: z.array(z.string()).optional(),
});

/**
 * Whether the question reached anybody.
 *
 * Decoded first, because a server-side tool's result arrives as a JSON-encoded string and a prefix
 * matched against the raw value never matches: that mistake drew every successful handoff as
 * Blocked. A route that could not reach a person is the case worth drawing differently, because the
 * Bot has stopped and nobody has been asked.
 */
function reached(result: unknown): boolean {
  return saidItWentAhead(result, PUT_TO);
}

/** The plain line: what was asked, and why, behind a disclosure. */
function AskedLine({
  question,
  why,
  result,
  running,
}: {
  question?: string;
  why?: string;
  result: unknown;
  running: boolean;
}) {
  return (
    <ToolLine
      label="Asked you"
      detail={question}
      running={running}
      refused={!running && !reached(result)}
    >
      <div className="space-y-1 text-sm">
        {question ? <p>{question}</p> : null}
        {/*
         * Why it stopped, which is the half a person is owed. "I need a decision only you can
         * make" and "I could not find the answer" look the same from the outside and are not.
         */}
        {why ? <p className="text-muted-foreground">{why}</p> : null}
      </div>
    </ToolLine>
  );
}

/**
 * A question with answers to pick from, drawn as the choice card.
 *
 * The Bot's turn ended when it asked, so an answer is not a tool result here: it is the person's
 * next message, sent through the conversation exactly as if they had typed it — which is also why a
 * typed answer and a picked one arrive the same way. Answered is read off the transcript (the first
 * message the person sent after the question), so a reload, or an answer typed into the composer
 * instead, draws the card answered too.
 *
 * Outside a conversation that can take a message, or once dismissed, it is the plain line.
 */
export function AskWithOptions({
  toolCallId,
  question,
  why,
  options,
  result,
  running,
}: {
  toolCallId: string;
  question?: string;
  why?: string;
  options: string[];
  result: unknown;
  running: boolean;
}) {
  const conversation = useConversation();
  const [dismissed, setDismissed] = useState(false);
  // A refused question was never put to anybody, so there is nothing to answer.
  const refused = result !== undefined && !reached(result);
  if (!conversation || dismissed || refused) {
    return (
      <AskedLine
        question={question}
        why={why}
        result={result}
        running={running}
      />
    );
  }

  const args = {
    title: question ?? "",
    ...(why ? { summary: why } : {}),
    // The label is what the person says when they pick it, so it is the id too.
    options: options.map((label) => ({ id: label, label })),
  };
  const answer = conversation.answers?.get(toolCallId);

  if (!question) {
    // Still being written: the card's own "waiting" title until the question arrives.
    return (
      <ChoiceCard
        args={{ options: args.options }}
        respond={undefined}
        result={undefined}
        status="inProgress"
      />
    );
  }
  if (answer !== undefined) {
    return (
      <ChoiceCard
        args={args}
        respond={undefined}
        result={JSON.stringify({ choice: answer, label: answer })}
        status="complete"
      />
    );
  }
  return (
    <ChoiceCard
      args={args}
      onDismiss={() => setDismissed(true)}
      respond={async (picked) => {
        const label =
          picked && typeof picked === "object" && "label" in picked
            ? String(picked.label)
            : "";
        if (!label) return;
        // Not sent at all (the Bot still had the turn): the card takes an answer again.
        if ((await conversation.ask(label)) === false)
          throw new Error("The answer was not sent.");
      }}
      result={undefined}
      status="executing"
    />
  );
}

export function EscalationTool() {
  useRenderTool({
    name: "ask_person",
    parameters,
    render: ({ parameters: given, result, status, toolCallId }) => {
      const running = status !== "complete" && result === undefined;
      const options = (given?.options ?? []).filter(
        (option): option is string =>
          typeof option === "string" && option.trim() !== "",
      );
      if (options.length > 0) {
        return (
          <AskWithOptions
            options={options}
            question={given?.question}
            result={result}
            running={running}
            toolCallId={toolCallId}
            why={given?.why}
          />
        );
      }
      return (
        <AskedLine
          question={given?.question}
          why={given?.why}
          result={result}
          running={running}
        />
      );
    },
  });

  return null;
}
