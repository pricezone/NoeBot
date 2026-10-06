import { IconX } from "@tabler/icons-react";
import type {
  MarketplaceSearch,
  SetMarketplaceSearch,
} from "@/components/marketplace/search";
import { EditSkill } from "@/components/skills/edit-skill";
import { NewSkill } from "@/components/skills/new-skill";
import { SkillsSections } from "@/components/skills/skills-sections";
import { Button } from "@/components/ui/button";

/**
 * The skills list, with the form for writing or editing one beside it.
 *
 * The pane is a column of its own at md and up and stacks below the list under that, inside the
 * modal rather than in a `DetailPanel`: the modal already is the overlay, and a sheet sliding over
 * a dialog would be two layers of the same idea. Which form is open is the Marketplace's own
 * search (`?new`, `?edit=slug`), so the form is linkable and Back closes it, as it was on `/skills`.
 */
export function SkillsTab({
  search,
  onSearchChange,
}: {
  search: MarketplaceSearch;
  onSearchChange: SetMarketplaceSearch;
}) {
  // Creating wins if both are somehow set: it is the more recent intent, the same rule the agents
  // tab uses when `new` and `agent` arrive together.
  const showCreate = search.new === true;
  const showEdit = !showCreate && search.edit !== undefined;
  const close = () => onSearchChange({ tab: "skills", q: search.q });

  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        <SkillsSections query={search.q ?? ""} />
      </div>
      {showCreate || showEdit ? (
        <aside
          aria-label={showCreate ? "New skill" : "Edit skill"}
          className="relative shrink-0 border-t border-border pt-4 md:w-[360px] md:border-t-0 md:border-l md:pt-0"
        >
          <Button
            aria-label="Close"
            className="absolute top-2 right-2 z-10 rounded-full"
            onClick={close}
            size="icon-sm"
            variant="ghost"
          >
            <IconX />
          </Button>
          {showCreate ? (
            <NewSkill />
          ) : search.edit !== undefined ? (
            <EditSkill key={search.edit} slug={search.edit} />
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
