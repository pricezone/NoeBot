/**
 * The rules a compose screen follows before there is a channel to hold them.
 *
 * Pure helpers so recipient-cap and sendability behavior stay testable without rendering.
 */

export type Recipient = {
  id: string;
  name: string;
};

/**
 * One coworker per channel.
 *
 * Matches the chat screen's current one-coworker render contract.
 */
export const MAX_RECIPIENTS = 1;

/**
 * How many Bots a group conversation may hold: the most `POST /api/groups` accepts.
 *
 * The compose screen in group mode takes up to this many. Two or more start a group; one is a
 * direct conversation, the same as picking that Bot outside group mode.
 */
export const MAX_GROUP_RECIPIENTS = 20;

/** Add a coworker, replacing the oldest once the recipient cap is reached. */
export function addRecipient(
  current: readonly Recipient[],
  next: Recipient,
  max: number = MAX_RECIPIENTS,
): Recipient[] {
  if (current.some((recipient) => recipient.id === next.id)) {
    return [...current];
  }
  return [...current, next].slice(-max);
}

export function removeRecipient(
  current: readonly Recipient[],
  id: string,
): Recipient[] {
  return current.filter((recipient) => recipient.id !== id);
}

/**
 * Whether this draft can start a channel: exactly one Bot outside group mode, and in it anywhere
 * from one (a direct conversation) up to the group cap.
 */
export function canSend(
  recipients: readonly Recipient[],
  text: string,
  group = false,
): boolean {
  const fits = group
    ? recipients.length >= 1 && recipients.length <= MAX_GROUP_RECIPIENTS
    : recipients.length === MAX_RECIPIENTS;
  return fits && text.trim().length > 0;
}
