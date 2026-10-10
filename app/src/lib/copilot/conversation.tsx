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
};

const ConversationContext = createContext<Conversation | null>(null);

export function ConversationProvider({
  ask,
  answers,
  children,
}: {
  ask: Conversation["ask"];
  answers?: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  // Keep context identity stable across unrelated composer renders.
  const value = useMemo(
    () => (answers ? { ask, answers } : { ask }),
    [ask, answers],
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
