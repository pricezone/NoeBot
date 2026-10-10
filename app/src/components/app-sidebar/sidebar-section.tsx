import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteSectionMutationOptions,
  MAX_SECTION_NAME_LENGTH,
  renameSectionMutationOptions,
  reorderSectionsMutationOptions,
  type SidebarSection as Section,
} from "@/lib/channels/sections";
import { NameDialog } from "./name-dialog";

/**
 * The heading of one of this person's sections in the sidebar.
 *
 * A button that folds the section shut and open again (remembered per browser, see
 * ./collapsed-sections.ts), with a small menu of its own beside it for what a section can have
 * done to it: rename, move up or down among the others, delete. Deleting asks first and says what
 * happens, because "delete" next to a list of conversations reads as deleting them, and it does not:
 * they go back to the ungrouped list.
 *
 * ONLY THE HEADING. The chats under it are rows of the sidebar's one roster list, drawn after this
 * heading as its siblings rather than inside it, so a chat moved from one section to another is
 * the same row moving, not one row unmounting and another mounting: its menu, its dialogs and its
 * position animation all survive the move. See `app-sidebar.tsx`.
 *
 * A section with nothing in it says how to fill it, so a heading that was just made does not look
 * like it failed to work.
 */
export function SidebarSectionHeader({
  section,
  sectionIds,
  collapsed,
  onToggle,
  isEmpty,
}: {
  section: Section;
  /** Every section's id in drawing order, which a move up or down rewrites. */
  sectionIds: readonly string[];
  collapsed: boolean;
  onToggle: () => void;
  isEmpty: boolean;
}) {
  const queryClient = useQueryClient();
  const rename = useMutation(renameSectionMutationOptions(queryClient));
  const remove = useMutation(deleteSectionMutationOptions(queryClient));
  const reorder = useMutation(reorderSectionsMutationOptions(queryClient));
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const index = sectionIds.indexOf(section.id);

  const move = (offset: -1 | 1) => {
    const target = index + offset;
    if (index < 0 || target < 0 || target >= sectionIds.length) return;
    const order = [...sectionIds];
    [order[index], order[target]] = [
      order[target] as string,
      order[index] as string,
    ];
    reorder.mutate(order);
  };

  return (
    <div className="pt-3" data-testid="sidebar-section">
      <div className="group/section flex h-8 items-center gap-1 pr-1 pl-2">
        <button
          aria-expanded={!collapsed}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={onToggle}
          type="button"
        >
          {collapsed ? (
            <IconChevronRight aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <IconChevronDown aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{section.name}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Options for ${section.name}`}
                className="size-7 rounded-full text-muted-foreground opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <IconDots />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <IconPencil />
              Rename section…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index <= 0} onClick={() => move(-1)}>
              <IconArrowUp />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index < 0 || index >= sectionIds.length - 1}
              onClick={() => move(1)}
            >
              <IconArrowDown />
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                remove.reset();
                setConfirmingDelete(true);
              }}
              variant="destructive"
            >
              <IconTrash />
              Delete section…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {reorder.error ? (
        <p className="px-3 pb-1 text-destructive text-xs" role="alert">
          {reorder.error.message}
        </p>
      ) : null}
      {!collapsed && isEmpty ? (
        <p className="px-3 py-2 text-[13px] text-muted-foreground/70">
          Right-click a chat and choose “Move to new section” to file it here.
        </p>
      ) : null}
      {renaming ? (
        <NameDialog
          initialName={section.name}
          label="Section name"
          maxLength={MAX_SECTION_NAME_LENGTH}
          onClose={() => setRenaming(false)}
          onSubmit={async (name) => {
            await rename.mutateAsync({ sectionId: section.id, name });
          }}
          submitLabel="Rename"
          title="Rename section"
        />
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
        open={confirmingDelete}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{section.name}”?</DialogTitle>
            <DialogDescription>
              Its chats are not deleted. They move back to the main list.
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p className="text-destructive text-sm" role="alert">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirmingDelete(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() => {
                remove.mutate(section.id, {
                  onSuccess: () => setConfirmingDelete(false),
                });
              }}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? "Deleting…" : "Delete section"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
