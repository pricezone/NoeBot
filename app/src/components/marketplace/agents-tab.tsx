import { AgentDialog } from "@/components/agents/agent-dialog";
import { AgentRoster } from "@/components/agents/agent-roster";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import type {
  MarketplaceSearch,
  SetMarketplaceSearch,
} from "@/components/marketplace/search";

/**
 * The roster of coworkers, with the dialogs that create and inspect one.
 *
 * Both dialogs stack over the Marketplace's own dialog. Base UI draws no backdrop for a nested
 * dialog unless asked, so the modal underneath stays readable rather than going dark twice; the
 * dialog on top is still the one with focus and Escape closes it first. Which one is open is the
 * Marketplace's search (`?new`, `?agent=id`), so Back closes it, as it did on `/agents`.
 */
export function AgentsTab({
  search,
  onSearchChange,
}: {
  search: MarketplaceSearch;
  onSearchChange: SetMarketplaceSearch;
}) {
  // Creating wins if both are somehow set: it is the more recent intent.
  const showCreate = search.new === true;
  const showProfile = !showCreate && search.agent !== undefined;
  const close = () => onSearchChange({ tab: "agents", q: search.q });

  return (
    <>
      <AgentRoster query={search.q ?? ""} />
      <CreateAgentDialog
        onClose={close}
        onCreated={(agentId) =>
          onSearchChange({ tab: "agents", q: search.q, agent: agentId })
        }
        open={showCreate}
      />
      <AgentDialog
        agentId={search.agent ?? null}
        onClose={close}
        open={showProfile}
      />
    </>
  );
}
