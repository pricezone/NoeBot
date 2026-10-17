import { useState } from "react";
import { QuestionCard } from "@/components/chat-cards/question-card";
import { useConversation } from "@/lib/copilot/conversation";
import { trailingYesNoQuestion } from "@/lib/copilot/yes-no";
import { useUiStrings } from "@/lib/i18n/strings";

type Message = {
  role?: string;
  content?: unknown;
  toolCalls?: unknown;
};

/** A message's words, whether it carries a string or text parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
        ? part.text
        : "",
    )
    .join(" ")
    .trim();
}

/**
 * The yes-or-no question the conversation ends on, when the Bot asked it in its own words: the last
 * message is the Bot's, with words and no tool calls, and its last paragraph opens with a question
 * Yes or No answers. Null while anything else is going on.
 */
export function yesNoQuestionAtEnd(
  messages: readonly Message[],
): string | null {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  if (Array.isArray(last.toolCalls) && last.toolCalls.length > 0) return null;
  return trailingYesNoQuestion(textOf(last.content));
}

/**
 * Yes and No under a reply that ends on a yes-or-no question, and a field for the person's own
 * answer. Picking one says it as the person's message, the way a question card's option does.
 *
 * `ask_person` with `yesNo` draws this on its own card; this is for the Bot that wrote the question
 * into its reply instead, so the person still answers with one tap.
 */
export function YesNoReply({
  messages,
  busy,
}: {
  messages: readonly Message[];
  busy: boolean;
}) {
  const conversation = useConversation();
  const ui = useUiStrings();
  const [sending, setSending] = useState<string | null>(null);
  const question = yesNoQuestionAtEnd(messages);
  if (!conversation || busy || !question) return null;

  const say = async (key: string, text: string) => {
    setSending(key);
    try {
      await conversation.ask(text);
    } finally {
      setSending(null);
    }
  };
  return (
    <QuestionCard
      onOwnAnswer={(text) => void say("own", text)}
      onPick={(option) => void say(option.id, option.label)}
      options={[
        { id: "yes", label: ui.yes },
        { id: "no", label: ui.no },
      ]}
      sending={
        sending === null
          ? undefined
          : sending === "own"
            ? { text: "" }
            : { optionId: sending }
      }
      title={question}
    />
  );
}
