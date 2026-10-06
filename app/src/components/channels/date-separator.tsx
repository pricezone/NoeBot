import type { Message } from "@ag-ui/core";

/**
 * The line a transcript draws between two days: "Sat, Sep 19 1:04 AM", centred and muted, the way
 * a phone's messages app marks where one day's conversation ends and the next begins.
 *
 * The pure helpers live beside the component rather than in `chat-transcript.tsx` because that
 * file is the biggest in the app and already imports the markdown renderer, the scroller and the
 * lightbox; a unit test of "did the day change" should not have to pull all of that into a DOM.
 */

/** Whether `next` falls on a different calendar day from `prev`, by the viewer's local clock. */
export function dayChanged(prev: Date, next: Date): boolean {
  return (
    prev.getFullYear() !== next.getFullYear() ||
    prev.getMonth() !== next.getMonth() ||
    prev.getDate() !== next.getDate()
  );
}

/**
 * When a message was sent, or null when nothing on it says.
 *
 * Nothing stored by this deployment stamps a message today — the history store keeps what the
 * runtime handed it, and the runtime's `Message` carries no time of its own — so this reads the two
 * places a stamp could honestly arrive: `metadata.sentAt` (ISO-8601 or epoch milliseconds, the
 * field a server that starts stamping would set, since `metadata` is the one free-form bag the
 * schema allows) and a top-level `timestamp` (epoch milliseconds, the spelling the runtime's events
 * use). Anything unreadable is "no time" rather than "epoch zero": a separator saying
 * "Thu, Jan 1" above a message sent yesterday would be worse than none.
 */
export function messageSentAt(message: Message): Date | null {
  const bag = message as { metadata?: unknown; timestamp?: unknown };
  const metadata =
    bag.metadata && typeof bag.metadata === "object"
      ? (bag.metadata as { sentAt?: unknown })
      : undefined;
  return readStamp(metadata?.sentAt) ?? readStamp(bag.timestamp);
}

function readStamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Which rows get a separator drawn above them, and the time each one shows.
 *
 * A row with no stamp neither gets one nor resets the comparison: a tool line between two messages
 * sent a day apart is not a reason to lose the boundary between them. The first stamped row always
 * gets one, so a conversation that spans a single day still says which day that was — which is
 * what the Grok transcript does under its header.
 */
export function daySeparators(
  rows: readonly { id: string; at: Date | null }[],
): Map<string, Date> {
  const separators = new Map<string, Date>();
  let previous: Date | null = null;
  for (const row of rows) {
    if (row.at === null) continue;
    if (previous === null || dayChanged(previous, row.at)) {
      separators.set(row.id, row.at);
    }
    previous = row.at;
  }
  return separators;
}

/**
 * "Sat, Sep 19 1:04 AM". Built from parts rather than one `format` call because the locale's own
 * assembly puts a comma between the day and the time, and the reference transcript does not.
 */
export function formatSeparator(
  date: Date,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const { locale = "en-US", timeZone } = options;
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  return `${day} ${time}`;
}

export function DateSeparator({ date }: { date: Date }) {
  return (
    <p
      data-slot="date-separator"
      className="py-3 text-center text-[13px] text-muted-foreground"
    >
      <time dateTime={date.toISOString()}>{formatSeparator(date)}</time>
    </p>
  );
}
