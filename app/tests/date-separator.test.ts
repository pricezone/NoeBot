import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  dayChanged,
  daySeparators,
  formatSeparator,
  messageSentAt,
} from "@/components/channels/date-separator";

/**
 * The pure half of the transcript's date separators: which rows open a new day, and what the line
 * above them says. The component itself is one `<p>` around `formatSeparator`, so the words are
 * what is worth pinning.
 *
 * Dates below are built with the local-time constructor on purpose. `dayChanged` compares the
 * viewer's calendar, so a test written in UTC would pass or fail by the machine's time zone; a
 * local midnight is a local midnight wherever bun runs.
 */

test("the day changes at local midnight and nowhere else", () => {
  const lateEvening = new Date(2026, 8, 18, 23, 59);
  const justAfter = new Date(2026, 8, 19, 0, 1);
  const sameMorning = new Date(2026, 8, 19, 1, 4);

  expect(dayChanged(lateEvening, justAfter)).toBe(true);
  expect(dayChanged(justAfter, sameMorning)).toBe(false);
  expect(dayChanged(sameMorning, sameMorning)).toBe(false);
});

test("a year boundary and a same-date-other-month both count as a new day", () => {
  expect(dayChanged(new Date(2025, 11, 31, 22), new Date(2026, 0, 1, 2))).toBe(
    true,
  );
  expect(dayChanged(new Date(2026, 7, 19, 9), new Date(2026, 8, 19, 9))).toBe(
    true,
  );
});

test("the first stamped row and every day change get a separator; unstamped rows are skipped over", () => {
  const friday = new Date(2026, 8, 18, 22, 30);
  const saturday = new Date(2026, 8, 19, 1, 4);
  const saturdayLater = new Date(2026, 8, 19, 9, 0);

  const separators = daySeparators([
    { id: "greeting", at: friday },
    { id: "tool-line", at: null },
    { id: "reply", at: friday },
    { id: "hi", at: saturday },
    { id: "unstamped", at: null },
    { id: "later", at: saturdayLater },
  ]);

  expect([...separators.keys()]).toEqual(["greeting", "hi"]);
  expect(separators.get("hi")).toBe(saturday);
});

test("a transcript with nothing stamped draws no separators at all", () => {
  expect(
    daySeparators([
      { id: "a", at: null },
      { id: "b", at: null },
    ]).size,
  ).toBe(0);
});

test('the line reads "Sat, Sep 19 1:04 AM", without the locale\'s comma before the time', () => {
  // Pinned to UTC so the clock reading does not move with the machine running the test.
  const date = new Date(Date.UTC(2026, 8, 19, 1, 4));
  expect(formatSeparator(date, { timeZone: "UTC" })).toBe(
    "Sat, Sep 19 1:04 AM",
  );
});

test("a message is dated by metadata.sentAt or a runtime timestamp, and by nothing else", () => {
  const base = { id: "m", role: "user", content: "hi" } satisfies Message;

  expect(
    messageSentAt({
      ...base,
      metadata: { sentAt: "2026-09-19T01:04:00.000Z" },
    })?.toISOString(),
  ).toBe("2026-09-19T01:04:00.000Z");
  expect(
    messageSentAt({
      ...base,
      metadata: { sentAt: Date.UTC(2026, 8, 19, 1, 4) },
    })?.toISOString(),
  ).toBe("2026-09-19T01:04:00.000Z");
  expect(
    messageSentAt({
      ...base,
      timestamp: Date.UTC(2026, 8, 19, 1, 4),
    } as Message)?.toISOString(),
  ).toBe("2026-09-19T01:04:00.000Z");

  // No stamp, an unreadable one, and a NaN all mean "no time" rather than the epoch.
  expect(messageSentAt(base)).toBeNull();
  expect(
    messageSentAt({ ...base, metadata: { sentAt: "yesterday-ish" } }),
  ).toBeNull();
  expect(
    messageSentAt({ ...base, timestamp: Number.NaN } as Message),
  ).toBeNull();
});
