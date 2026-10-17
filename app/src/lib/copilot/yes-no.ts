/**
 * Whether a question reads as one a person answers with yes or no.
 *
 * The fallback for an `ask_person` question the Bot sent with no options and without `yesNo`: one
 * that opens the way a yes-or-no question opens and ends on a question mark still gets Yes and No to
 * pick from, so the person can answer with one tap. English by its first word; Greek by its opening
 * (accents and case aside) and its question mark, which is ";" in Greek.
 */

const ENGLISH =
  /^(do|does|did|is|are|can|could|should|shall|would|will|have|has)\s[\s\S]*\?$/i;

/** Greek openings, without accents: Θέλεις, Θέλετε, Να, Μπορώ, Μπορείς, Είναι, Έχεις. */
const GREEK = ["θελεις", "θελετε", "να ", "μπορω", "μπορεις", "ειναι", "εχεις"];

export function readsAsYesNo(question: string): boolean {
  const text = question.trim();
  if (ENGLISH.test(text)) return true;
  // NFD splits the accents off (and turns the Greek question mark into ";"), so they can be dropped.
  const plain = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("el");
  return (
    /[;?]$/.test(plain) && GREEK.some((opening) => plain.startsWith(opening))
  );
}
