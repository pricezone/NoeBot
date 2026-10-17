import { IconSearch } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { AgentsTab } from "@/components/marketplace/agents-tab";
import { AppsTab } from "@/components/marketplace/apps-tab";
import { ComposioAppDetail } from "@/components/marketplace/composio-app-detail";
import { InstalledCluster } from "@/components/marketplace/installed-cluster";
import { PluginDetail } from "@/components/marketplace/plugin-detail";
import {
  isMarketplaceTab,
  type MarketplaceSearch,
  type SetMarketplaceSearch,
} from "@/components/marketplace/search";
import { SkillsTab } from "@/components/marketplace/skills-tab";
import { TemplateDetail } from "@/components/templates/template-detail";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import { useTranslation } from "@/lib/i18n";

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
  const { t } = useTranslation();
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

  /*
   * A plugin's page takes the whole body, search and tabs included: the
   * back chevron is the way out, and it returns to the list with the term and the category kept.
   * Switching tab clears `plugin` already (the tab change narrows the address to `{ tab, q }`).
   */
  if (tab === "apps" && search.plugin !== undefined) {
    return (
      <div className="flex flex-1 flex-col px-5 py-5 md:px-10 md:py-6">
        <PluginDetail
          id={search.plugin}
          onBack={() =>
            onSearchChange({
              tab: "apps",
              q: search.q,
              ...(search.category === undefined
                ? {}
                : { category: search.category }),
              ...(search.featured === undefined
                ? {}
                : { featured: search.featured }),
            })
          }
        />
      </div>
    );
  }

  /* A Composio app's page, the same way; Back keeps the term and the Featured category. */
  if (tab === "apps" && search.app !== undefined) {
    return (
      <div className="flex flex-1 flex-col px-5 py-5 md:px-10 md:py-6">
        <ComposioAppDetail
          onBack={() =>
            onSearchChange({
              tab: "apps",
              q: search.q,
              ...(search.category === undefined
                ? {}
                : { category: search.category }),
              ...(search.featured === undefined
                ? {}
                : { featured: search.featured }),
            })
          }
          slug={search.app}
        />
      </div>
    );
  }

  /*
   * A Bot template's page takes the body the same way. The Bot dialogs still stack over the tab
   * (`?new`, `?agent=`), and either of those being open is the more recent intent, so the page
   * waits for them; Add lands on the new Bot's own dialog, which clears `template` on the way.
   */
  if (
    tab === "agents" &&
    search.template !== undefined &&
    search.new !== true &&
    search.agent === undefined
  ) {
    const list = {
      tab: "agents" as const,
      q: search.q,
      ...(search.category === undefined ? {} : { category: search.category }),
    };
    return (
      <div className="flex flex-1 flex-col px-5 py-5 md:px-10 md:py-6">
        <TemplateDetail
          id={search.template}
          onAdded={(agentId) => onSearchChange({ ...list, agent: agentId })}
          onBack={() => onSearchChange(list)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 px-5 py-5 md:px-10 md:py-6">
      <div className="flex items-center gap-3">
        <InputGroup className="h-12 flex-1 rounded-xl border-transparent bg-muted/60 shadow-none dark:bg-muted/60 [&_input]:text-[15px]">
          <InputGroupAddon className="pl-3">
            <IconSearch aria-hidden="true" className="size-4.5" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("Search across apps and skills")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search across apps and skills")}
            value={draft}
          />
        </InputGroup>
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
          <TabsTrigger value="apps">{t("Apps")}</TabsTrigger>
          <TabsTrigger value="skills">{t("Skills")}</TabsTrigger>
          <TabsTrigger value="agents">{t("Agents")}</TabsTrigger>
        </TabsList>
        <TabsPanel className="pt-3" value="apps">
          <AppsTab
            category={search.category}
            featured={search.featured}
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
