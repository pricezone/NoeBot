import type { Locale } from "../../../shared/i18n/locales";
import { deploymentLocales } from "./deployment-locale";

/**
 * The language a Bot answers a person in.
 *
 * A person whose interface is Greek expects a Greek answer, and a Bot left alone answers in the
 * language of its own prompt, which is English. So the person's standing instructions — the block
 * every built-in Bot of theirs reads, in chats, routines, the first turn and Slack alike — carry one
 * more line when their interface is not English. It is a line about how to answer, which is what
 * that block is for, and it goes last so the person's own words come first.
 *
 * Nothing is added for English: an English person's prompts stay exactly as they were, byte for
 * byte. The model reads English either way; only the language it answers in changes. The person's
 * own message wins: somebody with a Greek interface who writes in English gets English back.
 */
const GUIDANCE: Partial<Record<Locale, string>> = {
  el: "This person's interface is in Greek. Answer in Greek, unless they write to you in another language; then answer in theirs. Keep the names of products, apps, tools and commands as they are.",
};

export function interfaceLanguageGuidance(
  locale: Locale | null | undefined,
): string | null {
  return locale ? (GUIDANCE[locale] ?? null) : null;
}

/** The person's standing instructions with the language line after them, or alone. */
export function withInterfaceLanguage(
  instructions: string | null,
  locale: Locale | null | undefined,
): string | null {
  const line = interfaceLanguageGuidance(locale);
  if (!line) return instructions;
  const own = instructions?.trim() ?? "";
  return own ? `${own}\n\n${line}` : line;
}

/**
 * The language this person's interface speaks, as far as the server can tell: their own choice,
 * else the deployment's default for somebody who made none. Null means English.
 *
 * A stored choice counts whether or not the deployment offers the language yet: before Greek is
 * turned on for everybody, the only way to have chosen it is the preview switch, which is exactly
 * who should get Greek answers.
 */
export async function interfaceLocaleOf(
  chosen: () => Promise<Locale | null>,
  environment: Record<string, string | undefined> = process.env,
): Promise<Locale | null> {
  const own = await chosen().catch(() => null);
  return own ?? deploymentLocales(environment).defaultLocale;
}
