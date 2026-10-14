/**
 * The Greek catalogs, one per namespace, each its own chunk.
 *
 * An explicit map of `import()` calls rather than a glob: Vite would split a glob the same way, but
 * the tests run under bun, which has no `import.meta.glob`, and a map is something the type checker
 * holds to `NAMESPACES`. English has no catalogs at all: every key is its own English text.
 *
 * Namespaces follow the build's route chunks (`app/vite.config.ts`), so somebody who never opens
 * Admin never downloads its words:
 * - `common`: the shell, the chat and everything the chat-core chunk imports, wherever it lives.
 * - `sign`: the sign-in screen.
 * - `settings` and `admin`: their modals.
 * - `content`: this deployment's own data (templates, skills, categories, catalogue, avatars).
 * - `server`: sentences the server sends, translated where they are shown.
 */
export const NAMESPACES = [
  "common",
  "sign",
  "settings",
  "admin",
  "content",
  "server",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

type Catalog = { default: Record<string, string> };

export const EL_CATALOGS: Record<Namespace, () => Promise<Catalog>> = {
  common: () => import("@/locales/el/common.json"),
  sign: () => import("@/locales/el/sign.json"),
  settings: () => import("@/locales/el/settings.json"),
  admin: () => import("@/locales/el/admin.json"),
  content: () => import("@/locales/el/content.json"),
  server: () => import("@/locales/el/server.json"),
};
