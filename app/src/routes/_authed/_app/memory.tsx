import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/memory` is Settings › Memory now. The route stays so the old address still resolves, and
 * sends people on with whatever search they arrived with.
 */
export const Route = createFileRoute("/_authed/_app/memory")({
  // Passed through untouched: the redirect keeps every parameter and this route reads none.
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/memory", search, replace: true });
  },
});
