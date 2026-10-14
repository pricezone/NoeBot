/**
 * A routine's schedule in Greek, from the English the server says it in.
 *
 * The server words a schedule once (`describeCron` in `server/src/routines/schedule.ts`) and the
 * model reads those words, so they stay English. They come in a closed set of shapes, and this
 * reads those shapes back and says them in Greek. Anything else — a raw cron expression for a
 * schedule stranger than the shapes — answers null, and is shown as the server sent it.
 *
 * `server/tests/schedule-words.test.ts` holds this to every shape `describeCron` can produce, so a
 * new one there fails a test rather than showing up in English.
 */

const DAYS: Record<string, string> = {
  Sundays: "Κυριακή",
  Mondays: "Δευτέρα",
  Tuesdays: "Τρίτη",
  Wednesdays: "Τετάρτη",
  Thursdays: "Πέμπτη",
  Fridays: "Παρασκευή",
  Saturdays: "Σάββατο",
};

const TIME = String.raw`\d{2}:\d{2}`;

/** "A, B and C" back into its parts. */
function splitWords(text: string): string[] {
  const and = text.lastIndexOf(" and ");
  if (and === -1) return [text];
  return [...text.slice(0, and).split(", "), text.slice(and + " and ".length)];
}

/** Parts as Greek lists them: "Α, Β και Γ". */
function joinGreek(parts: string[]): string {
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} και ${parts[parts.length - 1]}`;
}

export function scheduleInGreek(english: string): string | null {
  let match = /^Every (\d+) minutes$/.exec(english);
  if (match) return `Κάθε ${match[1]} λεπτά`;

  match = new RegExp(`^Every day at (${TIME}(?:(?:, | and )${TIME})*)$`).exec(
    english,
  );
  if (match?.[1]) return `Κάθε μέρα στις ${joinGreek(splitWords(match[1]))}`;

  match = new RegExp(`^Weekdays at (${TIME})$`).exec(english);
  if (match) return `Τις καθημερινές στις ${match[1]}`;

  match = new RegExp(
    `^On the (\\d{1,2})(?:st|nd|rd|th) of the month at (${TIME})$`,
  ).exec(english);
  if (match) return `Την ${match[1]}η κάθε μήνα στις ${match[2]}`;

  match = new RegExp(`^(.+) at (${TIME})$`).exec(english);
  if (match?.[1]) {
    const days = splitWords(match[1]).map((day) => DAYS[day]);
    if (days.length > 0 && days.every((day) => day !== undefined))
      return `Κάθε ${joinGreek(days as string[])} στις ${match[2]}`;
  }
  return null;
}
