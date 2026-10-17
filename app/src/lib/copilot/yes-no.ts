/**
 * Whether a question reads as one a person answers with yes or no.
 *
 * The fallback for an `ask_person` question the Bot sent with no options and without `yesNo`: one
 * that opens the way a yes-or-no question opens and ends on a question mark still gets Yes and No to
 * pick from, so the person can answer with one tap. English by its first word; Greek by its opening
 * (accents and case aside) and its question mark, which is ";" in Greek.
 *
 * Not a choice between things ("Do you want staging or production?", "Θέλεις PDF ή Word;") nor a
 * polite request for information ("Could you tell me your company name?"): they open the same way,
 * and Yes or No answers neither.
 */

const ENGLISH =
  /^(do|does|did|is|are|can|could|should|shall|would|will|have|has)\s[\s\S]*\?$/i;

/** Greek openings, without accents: Θέλεις, Θέλετε, Να, Μπορώ, Μπορείς, Είναι, Έχεις. */
const GREEK = ["θελεις", "θελετε", "να ", "μπορω", "μπορεις", "ειναι", "εχεις"];

/**
 * A choice between things: "or" in English, "ή" in Greek. The Greek one is matched with its accent,
 * because without it "η" is the article ("Είναι η αναφορά έτοιμη;").
 */
const CHOICE = /\s(or|ή)\s/i;

/** Asking to be told something, in English and (without accents) in Greek. */
const TELL_ME =
  /\b(tell me|tell us|share|give me|let me know)\b|(πες|πειτε|δωσε|δωστε) μου|μου (πεις|πειτε|δωσεις|δωσετε|στειλεις|στειλετε)/i;

export function readsAsYesNo(question: string): boolean {
  const text = question.trim();
  if (CHOICE.test(text)) return false;
  // NFD splits the accents off (and turns the Greek question mark into ";"), so they can be dropped.
  const plain = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("el");
  if (TELL_ME.test(plain)) return false;
  if (ENGLISH.test(text)) return true;
  return (
    /[;?]$/.test(plain) && GREEK.some((opening) => plain.startsWith(opening))
  );
}

/**
 * The yes-or-no question a reply ends on, if it ends on one: the first question in its last
 * paragraph, when that reads as yes-or-no. "Would you like me to set up a reminder? If so, which
 * day suits you?" ends on "Would you like me to set up a reminder?", which Yes or No answers first.
 *
 * For a Bot that asked in its own words instead of with `ask_person`: the person still gets Yes and
 * No to tap, and their own words in the composer.
 */
export function trailingYesNoQuestion(reply: string): string | null {
  const paragraphs = reply
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last) return null;
  // Only a reply that ends by asking: a question mark, Greek or Latin, at its very end.
  if (!/[?;\u037e]\s*$/.test(last)) return null;
  const sentences = last.match(/[^.!?;\u037e\n]+[.!?;\u037e]+/g) ?? [];
  const first = sentences
    .map((sentence) => sentence.trim())
    .find((sentence) => /[?;\u037e]$/.test(sentence));
  return first && readsAsYesNo(first) ? first : null;
}
