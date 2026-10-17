/**
 * Where an old Admin address now lives: `/admin/<rest>` is `/settings/advanced/<rest>`, with the
 * search and hash kept. Bookmarks, emails and OAuth returns from before the move still land on the
 * screen they named, inside the Settings popup. Anything else comes back unchanged.
 */
export function advancedSettingsHref(href: string): string {
  return href.replace(/^\/admin(?=[/?#]|$)/, "/settings/advanced");
}
