import type { IndexedPlugin } from "./plugin-index";

/**
 * The words of a Marketplace plugin, said about this product.
 *
 * Cursor's index is read by more than one client, and some plugin authors name xAI's in what they
 * write ("Run your email marketing from Cursor and …"). Those sentences are what our Marketplace
 * shows, and there the product is Noë Bot, so the sync script rewrites that client's name to ours
 * in every piece of text a person reads: the display name, the description, each skill's
 * description and each variable's. Names, slugs, URLs and ids are left alone; they are contracts,
 * not prose.
 *
 * Only that client's name is rewritten, in the spellings authors use. A bare "Grok" in an author's
 * text can mean xAI's model, voice or assistant ("Add Grok voice to an app"), and stays.
 *
 * Pure, so the script applies it at sync time, `--rebrand` applies it to the committed file
 * offline, and the tests hold the committed file to it.
 */

/** The other client's name, spelled any of the ways authors write it. */
const OTHER_CLIENT = /\bgrok[\s_-]?bot(s?)\b/gi;

const PRODUCT_NAME = "Noë Bot";

/** `text` with the other client's name replaced by this product's. */
export function rebrandText(text: string): string {
  return text.replace(
    OTHER_CLIENT,
    (_name, plural: string) => `${PRODUCT_NAME}${plural}`,
  );
}

/**
 * The plugin with every readable string rebranded. The result keeps the entry's own key order, so
 * the committed file changes only where a sentence did.
 */
export function rebrandPlugin(plugin: IndexedPlugin): IndexedPlugin {
  return {
    ...plugin,
    displayName: rebrandText(plugin.displayName),
    description: rebrandText(plugin.description),
    skills: plugin.skills.map((skill) => ({
      ...skill,
      description:
        skill.description === null ? null : rebrandText(skill.description),
    })),
    variables: Object.fromEntries(
      Object.entries(plugin.variables).map(([name, variable]) => [
        name,
        {
          ...variable,
          description:
            variable.description === null
              ? null
              : rebrandText(variable.description),
        },
      ]),
    ),
  };
}
