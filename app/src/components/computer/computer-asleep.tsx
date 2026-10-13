import { hashKey, QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { useAvatarLooks } from "@/components/channels/avatar";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import type { AvatarChoice } from "@/components/noe-bot/pixel-art";
import { Button } from "@/components/ui/button";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";

/**
 * The Bot's face as its profile has it: the detail when it is in the cache (the bot panel always
 * has it), else the roster, else the id as the seed. Read from the cache and subscribed to it, with
 * the client optional, the way `useAvatarLooks` reads the roster.
 */
function useBotLook(botId: string): AvatarChoice {
  const client = useContext(QueryClientContext);
  const fromRoster = useAvatarLooks();
  const detailHash = hashKey(agentKeys.detail(botId));
  const subscribe = useCallback(
    (notify: () => void) =>
      client
        ? client.getQueryCache().subscribe((event) => {
            if (event.query.queryHash === detailHash) notify();
          })
        : () => undefined,
    [client, detailHash],
  );
  const detail = useSyncExternalStore(
    subscribe,
    () => client?.getQueryData<AgentProfile>(agentKeys.detail(botId)),
    () => undefined,
  );
  return detail
    ? {
        seed: detail.avatarSeed,
        color: detail.avatarColor,
        expression: detail.avatarExpression,
      }
    : fromRoster(botId);
}

/**
 * What a sleeping computer shows, in the panel's card and in the full-window viewer.
 *
 * Grok's treatment: the Bot itself, dozing, in its own colour, with two small Z's drifting off it
 * (still under reduced motion, see `.computer-asleep-z`), the line "Computer is asleep", and a pill
 * that wakes it. The whole card wakes it too; the pill is the same thing for a keyboard, which is
 * why the card's own target is out of the tab order and hidden from a screen reader.
 *
 * Fills its parent, which positions it: the card's frame, or the viewer's screen.
 */
export function ComputerAsleep({
  botId,
  onWake,
  large = false,
}: {
  botId: string;
  onWake: () => void;
  /** The viewer's size, rather than the card's. */
  large?: boolean;
}) {
  const look = useBotLook(botId);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-foreground">
      <button
        aria-hidden="true"
        className="absolute inset-0 cursor-pointer"
        onClick={onWake}
        tabIndex={-1}
        type="button"
      />
      <span className="pointer-events-none relative mb-1">
        <NoeBotAvatar
          {...look}
          face="sleepy"
          props={false}
          size={large ? 96 : 56}
        />
        <span
          aria-hidden="true"
          className={`computer-asleep-z absolute right-0 font-mono font-semibold text-muted-foreground ${large ? "-top-2 text-sm" : "-top-1 text-xs"}`}
        >
          z
        </span>
        <span
          aria-hidden="true"
          className={`computer-asleep-z computer-asleep-z-late absolute font-mono font-semibold text-muted-foreground ${large ? "-top-6 -right-4 text-xs" : "-top-3.5 -right-2 text-[10px]"}`}
        >
          z
        </span>
      </span>
      <span className="pointer-events-none relative font-medium text-sm">
        Computer is asleep
      </span>
      <Button
        className="relative rounded-full px-4"
        onClick={onWake}
        size="sm"
        variant="secondary"
      >
        Wake
      </Button>
    </div>
  );
}
