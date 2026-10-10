import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Starting a group conversation lives in the To: field now: `/channel/new` in group mode takes Bots
 * as chips, and two or more of them start a group on the first send. This address is kept for
 * whatever still links to it, and lands there with the field already in group mode.
 */
export const Route = createFileRoute("/_authed/_app/group/new")({
  beforeLoad: () => {
    throw redirect({
      to: "/channel/new",
      search: { compose: 1, group: 1 },
      replace: true,
    });
  },
});
