import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/bots` is Settings › Bots now. The route stays so the old address still resolves — it is in
 * bookmarks and in notification links already sent — and what it does is send people on, with
 * whatever search they arrived with.
 */
export const Route = createFileRoute("/_authed/_app/bots/")({
  // Passed through untouched: the redirect keeps every parameter and this route reads none.
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/bots", search, replace: true });
  },
});
