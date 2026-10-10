/**
 * A Bot made in one click, and the turn in which it speaks first.
 *
 * "Create new Bot" in the To: menu used to open a three-step form whose answers — a name, a title, a
 * role — are exactly what somebody who has not used the Bot yet cannot give. So the click makes a
 * Bot with sensible defaults and a conversation with it, and the Bot opens that conversation by
 * asking what it should help with. Its answer is where a name and a role come from, and the Bot
 * suggests them; the person renames it themselves, since a Bot cannot rename itself.
 *
 * THE FIRST TURN IS HEADLESS, because the person's browser has nothing to send: it runs on the same
 * turn runner as a Slack message or an approved action resuming, as the owner, metered like any
 * other turn. What it says reaches the open conversation the way a routine's reply does — persisted
 * to the thread by the runner, then announced with `recordActivity`, which patches the roster over
 * the socket, and the conversation screen re-reads its history when the roster says a Bot spoke.
 */

import { frameFirstTurn } from "../../../shared/first-turn";
import { PERSON_INITIATOR } from "../audit";
import type { AgentChannel, ChannelStore } from "../channels/routes";
import type { TurnRunner } from "../routines/runner";
import type { AgentActor, CreateAgentInput } from "./profile-types";

/**
 * The Bot one click makes. Private, because nobody else asked for it; general, because its first
 * conversation is where it finds out what it is for.
 */
export const NEW_BOT: CreateAgentInput = {
  name: "New Bot",
  title: "General assistant",
  roleDescription:
    "Help with whatever takes the most off the person's plate: research and writing, code and GitHub work, web tasks and errands, and recurring checks and reminders. When a request is clear, do the work; when it is not, ask one short question rather than guessing. Say plainly what you did and anything you could not do, and offer to turn work that will come round again into a routine.",
  visibility: "private",
};

/** Starts a new Bot's first turn in its conversation. Settles once the turn is over, never throws. */
export type FirstTurnStarter = (input: {
  actor: AgentActor;
  agentId: string;
  channel: Pick<AgentChannel, "id" | "threadId">;
}) => Promise<void>;

export function createFirstTurnStarter(options: {
  runTurn: TurnRunner;
  channels: Pick<ChannelStore, "recordActivity" | "signalBusy">;
  log?: (event: Record<string, unknown>) => void;
}): FirstTurnStarter {
  const {
    runTurn,
    channels,
    log = (event) => console.error(JSON.stringify(event)),
  } = options;

  return async ({ actor, agentId, channel }) => {
    const runId = crypto.randomUUID();
    // A missed busy signal costs a working dot, never the turn, so neither may throw out of here.
    const busy = (value: boolean) =>
      channels.signalBusy(channel.threadId, value).catch(() => undefined);
    let speaking = false;
    await busy(true);
    try {
      const frame = frameFirstTurn();
      const { replyText, asked } = await runTurn({
        ownerUserId: actor.id,
        routineId: `first-turn:${agentId}`,
        agentId,
        threadId: channel.threadId,
        instruction: frame,
        // The frame as the turn's own message, so the runner does not wrap it as a routine firing.
        userMessage: {
          id: `first-turn:${runId}`,
          role: "user",
          content: frame,
        },
        // The person asked for this Bot a moment ago; the turn is theirs, not a schedule's.
        initiator: PERSON_INITIATOR,
        /*
         * Said again once the Bot starts talking. The browser refetches its roster right after the
         * create, to show the new conversation, and a refetch drops the transient busy flag — so the
         * first signal, sent before the turn has even built its agent, is usually lost to it.
         */
        onText: () => {
          if (speaking) return;
          speaking = true;
          void busy(true);
        },
      });
      /*
       * What the turn left the person with: the question it ended on, when it asked one, since that
       * is what is waiting for them and what the roster should say. Announcing it is also what
       * makes an open conversation read the finished turn back from the thread.
       */
      await channels.recordActivity(
        actor,
        channel.id,
        { text: asked ?? replyText, agentId, at: new Date() },
        { id: `first-turn:${runId}` },
      );
    } catch (error) {
      /*
       * Logged rather than said in the conversation. The Bot and its conversation exist either way,
       * and an empty conversation with a composer under it is still one the person can start; a
       * failure notice from a Bot that never got to speak would be the first thing it ever said.
       */
      log({
        type: "first-turn-failed",
        agentId,
        channelId: channel.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await busy(false);
    }
  };
}
