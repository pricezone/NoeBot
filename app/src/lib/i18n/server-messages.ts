import { getLocale, i18n } from "./index";
import { ensureNamespaces } from "./set-locale";

/**
 * A sentence the server sent, in the language the interface speaks.
 *
 * The server answers in English, because the model reads the same answers and the server's tests
 * hold its words. Its sentences are keys of the `server` namespace, collected from its source
 * (`scripts/i18n/server-scan.ts`), and are translated here, where they reach a person:
 *
 * - exactly, for a sentence written as one literal;
 * - by pattern, for one built with values in it. The catalog key `"{{0}} is not a Bot template
 *   here."` matches `"Weekly digest is not a Bot template here."`, and the Greek is said with the
 *   value put back. A value that is itself a sentence the server says is translated too, so a
 *   refusal quoted inside another reads in one language.
 *
 * A sentence the catalog does not know is shown as the server sent it: English, never a key.
 */

type Pattern = { key: string; match: RegExp };

const VALUE = /\{\{\d+\}\}/;

let compiledFrom: unknown;
let patterns: Pattern[] = [];

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The catalog's patterns, most specific (most literal text) first, built once per catalog. */
function patternsOf(catalog: Record<string, string>): Pattern[] {
  if (catalog === compiledFrom) return patterns;
  compiledFrom = catalog;
  patterns = Object.keys(catalog)
    .filter((key) => VALUE.test(key))
    .map((key) => ({
      key,
      literal: key.replace(/\{\{\d+\}\}/g, "").length,
      match: new RegExp(
        `^${key.split(VALUE).map(escapeRegExp).join("([\\s\\S]+?)")}$`,
      ),
    }))
    .sort((a, b) => b.literal - a.literal)
    .map(({ key, match }) => ({ key, match }));
  return patterns;
}

export function localizeServerMessage(english: string): string {
  if (getLocale() === "en") return english;
  if (i18n.exists(english, { ns: "server" }))
    return i18n.t(english, { ns: "server" });
  const catalog = i18n.getResourceBundle(getLocale(), "server") as
    | Record<string, string>
    | undefined;
  if (!catalog) return english;
  for (const { key, match } of patternsOf(catalog)) {
    const found = match.exec(english);
    if (!found) continue;
    const values: Record<string, string> = {};
    found.slice(1).forEach((value, index) => {
      values[String(index)] = localizeServerMessage(value);
    });
    return i18n.t(key, { ns: "server", ...values });
  }
  return english;
}

/** Fetches the server's sentences in Greek the first time one is about to be shown. */
export async function loadServerMessages(): Promise<void> {
  if (getLocale() === "en") return;
  await ensureNamespaces(["server"]).catch(() => {
    // Without the catalog the sentence is shown in English, as the server sent it.
  });
}

/** For a read that already has the sentence: loads the catalog, then translates. */
export async function localizeServerMessageAsync(
  english: string,
): Promise<string> {
  await loadServerMessages();
  return localizeServerMessage(english);
}
