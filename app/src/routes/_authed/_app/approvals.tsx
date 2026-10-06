import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/approvals` is Settings › Approvals now. The route stays so the old address still resolves, and
 * sends people on with whatever search they arrived with.
 */
export const Route = createFileRoute("/_authed/_app/approvals")({
  // Passed through untouched: the redirect keeps every parameter and this route reads none.
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/approvals", search, replace: true });
  },
});
