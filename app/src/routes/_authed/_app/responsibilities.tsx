import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/responsibilities` is a block of Settings › Bots now. The route stays so the old address still
 * resolves, and sends people to that block with whatever search they arrived with.
 */
export const Route = createFileRoute("/_authed/_app/responsibilities")({
  // Passed through untouched: the redirect keeps every parameter and this route reads none.
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/settings/bots",
      search,
      hash: "responsibilities",
      replace: true,
    });
  },
});
