import { AgentDialog } from "@/components/agents/agent-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import type {
  MarketplaceSearch,
  SetMarketplaceSearch,
} from "@/components/marketplace/search";
import { TemplateMarket } from "@/components/templates/template-market";

/**
 * The Bots you can start from, and the ones you have, with the dialogs that create and inspect one.
 *
 * Every dialog stacks over the Marketplace's own dialog. Base UI draws no backdrop for a nested
 * dialog unless asked, so the modal underneath stays readable rather than going dark twice; the
 * dialog on top is still the one with focus and Escape closes it first. Which one is open is the
 * Marketplace's search (`?new`, `?agent=id`), so Back closes it. A template (`?template=id`) is
 * not a dialog: its page takes the Marketplace's body, as a plugin's does — see marketplace.tsx.
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
  const base = {
    tab: "agents" as const,
    q: search.q,
    ...(search.category === undefined ? {} : { category: search.category }),
  };
  const close = () => onSearchChange(base);

  return (
    <>
      <TemplateMarket onSearchChange={onSearchChange} search={search} />
      <CreateAgentDialog
        onClose={close}
        onCreated={(agentId) => onSearchChange({ ...base, agent: agentId })}
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
