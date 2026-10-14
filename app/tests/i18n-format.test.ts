import { afterEach, expect, test } from "bun:test";
import { formatSeparator } from "@/components/channels/date-separator";
import { i18n } from "@/lib/i18n";
import { compareText, formatList } from "@/lib/i18n/format";
import { resetI18nForTests } from "@/lib/i18n/set-locale";
import { relativeTime } from "@/lib/relative-time";
import { formatCredits } from "@/lib/usage/queries";

/**
 * Numbers, dates and times follow the interface's language, and English reads exactly as before.
 */

afterEach(async () => {
  await resetI18nForTests();
});

const sep19 = new Date("2026-09-19T01:04:00Z");

test("English figures, dates and times are unchanged", () => {
  expect(formatCredits(12480.4)).toBe("12,480");
  expect(formatSeparator(sep19, { timeZone: "UTC" })).toBe(
    "Sat, Sep 19 1:04 AM",
  );
  expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe(
    "5 minutes ago",
  );
  expect(formatList(["Ana", "Bo", "Cy"])).toBe("Ana, Bo, and Cy");
});

test("Greek figures, dates and times read as Greek", async () => {
  await i18n.changeLanguage("el");
  expect(formatCredits(12480.4)).toBe("12.480");
  expect(formatSeparator(sep19, { timeZone: "UTC" })).toMatch(/^Σάβ/);
  expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe(
    "πριν από 5 λεπτά",
  );
  expect(formatList(["Άννα", "Βασίλης", "Γιώργος"])).toBe(
    "Άννα, Βασίλης και Γιώργος",
  );
});

test("a switch of language reaches timestamps drawn after it", async () => {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  expect(relativeTime(fiveMinutesAgo)).toBe("5 minutes ago");
  await i18n.changeLanguage("el");
  expect(relativeTime(fiveMinutesAgo)).toBe("πριν από 5 λεπτά");
  await i18n.changeLanguage("en");
  expect(relativeTime(fiveMinutesAgo)).toBe("5 minutes ago");
});

test("sorting ignores case and accents, in the interface's language", async () => {
  expect(["beta", "Alpha", "alpha"].sort(compareText)).toEqual([
    "Alpha",
    "alpha",
    "beta",
  ]);
  await i18n.changeLanguage("el");
  expect(["Ώρα", "άλφα", "Βήτα"].sort(compareText)).toEqual([
    "άλφα",
    "Βήτα",
    "Ώρα",
  ]);
});
