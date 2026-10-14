import type { UseQueryResult } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { type AgentChannel, serverUnreachable } from "@/lib/channels/queries";
import { httpStatusOf } from "@/lib/client";
import { stringsFor, type UiLanguage } from "@/lib/i18n/strings";

/**
 * The channel screen until its channel is in hand, and through a server that goes away.
 *
 * FOUND LIVE: the server restarted for an automatic update mid-conversation, the channel read failed,
 * and the screen said "Could not load this channel." until somebody reloaded the page. The read is
 * now retried for about two minutes while the server is unreachable (`channelQueryOptions`), and
 * this draws that as a calm "Reconnecting…" rather than an error. Only when the retries run out is
 * the error said, with a Retry. A refusal (the channel is gone, or not this person's) is said at
 * once, in the server's words.
 *
 * A channel already in hand stays on screen while a later read of it fails to reach the server:
 * tearing the conversation down because the server blinked would lose the transcript and the
 * composer for nothing. Only a definite refusal takes it away.
 */
export function ChannelLoading({
  query,
  language,
  children,
}: {
  query: Pick<
    UseQueryResult<AgentChannel>,
    "data" | "error" | "isPending" | "isFetching" | "failureCount" | "refetch"
  >;
  /** The conversation's language, as last noted (`useNotedLanguage`): this is drawn outside it. */
  language: UiLanguage;
  children: (channel: AgentChannel) => ReactNode;
}) {
  const ui = stringsFor(language);
  /** Retry was pressed: the read it starts is a reconnection from its first attempt. */
  const [retried, setRetried] = useState(false);
  const { data, error } = query;
  const unreachable = error !== null && serverUnreachable(error);

  if (data !== undefined && (error === null || unreachable))
    return children(data);
  // Nothing while the channel loads: a placeholder inside a local round-trip is a flicker.
  if (query.isPending && query.failureCount === 0 && !retried) return null;
  if (query.isPending || (unreachable && query.isFetching)) {
    return (
      <p className="p-8 text-muted-foreground text-sm" role="status">
        {ui.reconnecting}
      </p>
    );
  }

  const status = httpStatusOf(error);
  const refused = status !== undefined && status >= 400 && status < 500;
  return (
    <div className="flex flex-col items-start gap-3 p-8" role="alert">
      <p className="text-destructive text-sm">
        {refused && error ? ui.reason(error.message) : ui.channelLoadFailed}
      </p>
      {refused ? null : (
        <Button
          onClick={() => {
            setRetried(true);
            void query.refetch();
          }}
          size="sm"
          variant="outline"
        >
          {ui.retry}
        </Button>
      )}
    </div>
  );
}
