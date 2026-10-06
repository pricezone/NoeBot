import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { marketplaceSearchSchema } from "@/components/marketplace/search";
import { ModalShell } from "@/components/ui/modal-shell";

/**
 * The Marketplace: the apps a Bot can reach as you, the skills you have written, and the
 * coworkers you can talk to, in one modal over the app shell. "Connect apps" in the sidebar opens
 * it; `/skills` and `/agents` redirect into its tabs.
 *
 * The body is loaded lazily. This file sits under `_authed/_app/` and so is bundled into the
 * secondary app chunk (`vite.config.ts`); the body carries the agent dialogs, the skill forms and
 * the Composio directory, which a person opening a chat has no use for, so it is its own chunk
 * fetched the first time the modal opens.
 */
const MarketplaceBody = lazy(
  () => import("@/components/marketplace/marketplace"),
);

export const Route = createFileRoute("/_authed/_app/marketplace/")({
  validateSearch: marketplaceSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ModalShell title="Marketplace" width={1000}>
      <Suspense fallback={null}>
        <MarketplaceBody
          onSearchChange={(next, options) =>
            void navigate({ search: next, replace: options?.replace })
          }
          search={search}
        />
      </Suspense>
    </ModalShell>
  );
}
