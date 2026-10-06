import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/**
 * `/agents` moved into the Marketplace's Agents tab. The URL is kept as a redirect so an old link
 * — a card's Details link in a stale tab, a bookmark, an "Open the coworker" card in an older
 * transcript — still lands on the roster, with `?new` and `?agent=` carried across so the dialog
 * it named opens.
 */
const agentsSearchSchema = z.object({
  new: z.boolean().optional(),
  agent: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/marketplace",
      search: { tab: "agents", ...search },
      replace: true,
    });
  },
});
