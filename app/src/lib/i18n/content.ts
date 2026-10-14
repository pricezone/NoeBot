import { useCallback } from "react";
import { useTranslation } from "./index";

/**
 * This deployment's own content, in the language the interface speaks.
 *
 * Templates, skills, stock Bots, the catalogue, template categories and avatar colours arrive as
 * English data: the model reads the same words, and the package compares them. Their Greek lives in
 * the `content` namespace, keyed by that English (`scripts/i18n/content-scan.ts` says which words
 * are ours), and is looked up here where they are drawn. Text the catalog does not hold, a
 * third-party app's summary or a skill somebody wrote, is shown as it is.
 *
 * Search over this content should match both: what is on the screen, and the English underneath.
 */
export function useContentText(): (text: string) => string {
  const { t } = useTranslation("content");
  return useCallback(
    (text: string) => (text ? t(text, { defaultValue: text }) : text),
    [t],
  );
}
