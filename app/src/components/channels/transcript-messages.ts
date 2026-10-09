import type { Message } from "@ag-ui/core";
import { brand } from "@/lib/brand";

/**
 * What a transcript shows while a brand-new channel is still joining.
 *
 * NOT DECIDED ON `messages.length`: the runtime replaces its messages wholesale, so the seed would
 * be dropped on the first assistant token with the person's own turn already gone. A role rather
 * than an id, because the agent's copy and the restored copy each mint their own.
 */
export function transcriptMessages(
  messages: readonly Message[],
  seed: Message | null,
): readonly Message[] {
  if (seed === null) {
    return messages;
  }
  if (messages.some((message) => message.role === "user")) {
    return messages;
  }
  return [seed, ...messages];
}

/** The person's message, in the shape the transcript and the agent both take. */
export function seedMessage(text: string, id: string): Message {
  return { id, role: "user", content: text };
}

/** The greeting's id. Fixed, because a fresh one per render would remount the row every time. */
export const FIRST_RUN_GREETING_ID = "first-run-greeting";

/**
 * What somebody with no conversations yet is greeted with on the compose screen.
 *
 * LOCAL ONLY. The transcript draws it and nothing else sees it: it is never sent to the model and
 * never stored, so the channel the first send creates starts from the person's own words. A plain
 * assistant text message, because that is what `toVisibleChatItems` already draws as the Bot
 * speaking.
 */
export function firstRunGreeting(): Message {
  return {
    id: FIRST_RUN_GREETING_ID,
    role: "assistant",
    content: `Hi, I'm ${brand.productName}. Type a message below to get started — I'll start my computer, and you can watch it work in the panel on the right.`,
  };
}

/**
 * The message a channel was created by, waiting for the screen that will send it.
 *
 * A module-level map rather than router state because `HistoryState` is an empty interface and
 * typing a value into it means augmenting `@tanstack/history`, which is not a dependency of this
 * app. It also earns something router state would not give: taking is destructive, so a component
 * that mounts twice cannot send the same message twice.
 *
 * Deliberately not persisted. A reload finds nothing here, which is correct, by then the message
 * is in the thread and arrives through the normal replay.
 */
const firstMessages = new Map<string, string>();

export function stashFirstMessage(channelId: string, text: string): void {
  firstMessages.set(channelId, text);
}

/** Read the pending first message and forget it. Null for a channel opened any other way. */
export function takeFirstMessage(channelId: string): string | null {
  const text = firstMessages.get(channelId) ?? null;
  firstMessages.delete(channelId);
  return text;
}
