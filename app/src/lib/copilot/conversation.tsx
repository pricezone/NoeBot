import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * Lets transcript-rendered components add a user turn back into the containing conversation.
 */

type Conversation = {
  /**
   * Submit a user turn from a transcript-rendered component. It may answer (or resolve to) whether
   * the turn went out: `false` when it could not be sent at all, so a card can take back an answer
   * that never left. Anything else says nothing either way.
   */
  ask: (text: string) => unknown;
  /**
   * What the person said after each question a Bot put to them, by the question's tool call id.
   * Absent where the conversation does not track it, which leaves every question unanswered.
   */
  answers?: ReadonlyMap<string, string>;
  /**
   * Whether this tab has a turn going: a run on the wire, or a turn waiting on the browser between
   * runs. A decision card with no result that this tab is NOT running is one nobody here can answer
   * through the run — another tab started it, or this one was reloaded — so it is answered by
   * message instead. Absent where the conversation does not say, which leaves such cards as they are.
   */
  turnActive?: boolean;
};

const ConversationContext = createContext<Conversation | null>(null);

export function ConversationProvider({
  ask,
  answers,
  turnActive,
  children,
}: {
  ask: Conversation["ask"];
  answers?: ReadonlyMap<string, string>;
  turnActive?: boolean;
  children: ReactNode;
}) {
  // Keep context identity stable across unrelated composer renders.
  const value = useMemo(
    () => ({
      ask,
      ...(answers ? { answers } : {}),
      ...(turnActive === undefined ? {} : { turnActive }),
    }),
    [ask, answers, turnActive],
  );
  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

/** The conversation this component is drawn in, if it is drawn in one. */
export function useConversation(): Conversation | null {
  return useContext(ConversationContext);
}
