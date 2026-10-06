import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { ComposioAppList } from "@/components/plugins/composio-app-list";
import { Input } from "@/components/ui/input";

/**
 * Composio's directory, searched rather than listed.
 *
 * The catalogue on the previous screen is a reviewed handful, and every entry there is a decision
 * somebody made about a vendor. This is a few hundred apps that nobody here has reviewed, which is
 * why it is a search field and not a list: the only sensible entry point into a directory that size
 * is the name of the app you already came looking for.
 *
 * The list itself lives in `components/plugins/composio-app-list.tsx`, because the Marketplace
 * draws the same directory under "Featured plugins"; this page is the search field and the frame.
 */
export const Route = createFileRoute("/_authed/admin/plugins/composio")({
  component: RouteComponent,
});

/** Re-exported so the ordering rule keeps its old import path beside the page that first drew it. */
export { matchingApps } from "@/components/plugins/composio-app-list";

function RouteComponent() {
  const [search, setSearch] = React.useState("");

  return (
    <PageShell
      backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
      description="Composio's own directory. Adding an app makes its tools available to grant; each person still connects their own account before any of them reads anything."
      title="Browse Composio"
    >
      <PageSection
        description="Search by name. The directory is too long to read, and nothing here has been reviewed by this deployment."
        title="Apps"
      >
        <Input
          aria-label="Search Composio apps"
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by app name"
          value={search}
        />
        <ComposioAppList search={search} />
      </PageSection>
    </PageShell>
  );
}
