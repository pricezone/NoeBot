import { IconArrowUpRight, IconSearch } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AgentsTab } from "@/components/marketplace/agents-tab";
import { AppsTab } from "@/components/marketplace/apps-tab";
import { InstalledCluster } from "@/components/marketplace/installed-cluster";
import {
  isMarketplaceTab,
  type MarketplaceSearch,
  type SetMarketplaceSearch,
} from "@/components/marketplace/search";
import { SkillsTab } from "@/components/marketplace/skills-tab";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";

/**
 * The body of the Marketplace modal: the search, the installed cluster, and the three tabs.
 *
 * A default export because the route loads it with `React.lazy`: the Marketplace carries the
 * agent dialogs, the skill forms and the Composio directory, none of which a person opening a chat
 * needs, and the route file under `_authed/_app/` would otherwise pull them into the secondary
 * app chunk at first paint.
 *
 * Everything here is the route's search: the tab, the term, and the one form or dialog open over
 * the tab. The route hands it down with a setter, so the body neither knows the route id nor
 * needs the router in a test beyond what its `Link`s ask for.
 */
export default function Marketplace({
  search,
  onSearchChange,
}: {
  search: MarketplaceSearch;
  onSearchChange: SetMarketplaceSearch;
}) {
  const tab = search.tab ?? "apps";
  const query = search.q ?? "";

  /*
   * The field is controlled by local state and the URL follows it, not the other way round. A
   * controlled input whose value comes back through a navigation lands a render late, which is
   * what makes the caret jump on a fast typist; local state keeps the keystroke on screen in the
   * same frame. The URL still wins when it changes from outside — Back, or a link into a search —
   * which `pushed` tells apart from the echo of our own navigation.
   */
  const [draft, setDraft] = useState(query);
  const pushed = useRef(query);
  useEffect(() => {
    if (query !== pushed.current) {
      pushed.current = query;
      setDraft(query);
    }
  }, [query]);

  const setQuery = (value: string) => {
    setDraft(value);
    pushed.current = value;
    onSearchChange(
      { ...search, q: value === "" ? undefined : value },
      // A keystroke is not a place to go Back to.
      { replace: true },
    );
  };

  return (
    <div className="flex flex-1 flex-col gap-5 px-5 py-5 md:px-10 md:py-6">
      <div className="flex items-center gap-3">
        <InputGroup className="h-12 flex-1 rounded-xl border-transparent bg-muted/60 shadow-none dark:bg-muted/60 [&_input]:text-[15px]">
          <InputGroupAddon className="pl-3">
            <IconSearch aria-hidden="true" className="size-4.5" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search across apps and skills"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search across apps and skills"
            value={draft}
          />
        </InputGroup>
        {/* Grok Bot's own link out of the apps popup: the Bots you can start from. Ours is a tab. */}
        <Link
          className="hidden shrink-0 items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:flex"
          search={{ tab: "agents" }}
          to="/marketplace"
        >
          Bot templates
          <IconArrowUpRight aria-hidden="true" className="size-3.5" />
        </Link>
        <InstalledCluster />
      </div>

      <Tabs
        onValueChange={(value) => {
          if (!isMarketplaceTab(value) || value === tab) return;
          // The term carries across; the open form or dialog belongs to the tab it was on.
          onSearchChange({ tab: value, q: search.q });
        }}
        value={tab}
      >
        <TabsList activateOnFocus variant="underline">
          <TabsTrigger value="apps">Apps</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
        </TabsList>
        <TabsPanel className="pt-3" value="apps">
          <AppsTab
            category={search.category}
            onSearchChange={onSearchChange}
            query={query}
          />
        </TabsPanel>
        <TabsPanel className="pt-3" value="skills">
          <SkillsTab onSearchChange={onSearchChange} search={search} />
        </TabsPanel>
        <TabsPanel className="pt-3" value="agents">
          <AgentsTab onSearchChange={onSearchChange} search={search} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
