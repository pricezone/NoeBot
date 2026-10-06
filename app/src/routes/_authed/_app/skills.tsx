import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/**
 * `/skills` moved into the Marketplace's Skills tab. The URL is kept as a redirect so an old link
 * — the sidebar of a stale tab, a bookmark, a `Put it on a Bot` card in an older transcript —
 * still lands on the list, with its `?new` and `?edit=` carried across so the form it named opens.
 */
const skillsSearchSchema = z.object({
  new: z.boolean().optional(),
  /** The slug being edited. Absent means nothing is. */
  edit: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: skillsSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/marketplace",
      search: { tab: "skills", ...search },
      replace: true,
    });
  },
});
