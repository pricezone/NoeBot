import { IconChevronDown } from "@tabler/icons-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The row of category pills under a Marketplace search: All, then each category, with the tail
 * folded into a "More" menu when there are more than fit a line. Shared by the Apps and Agents tabs
 * so the two rows are one look: `rounded-full px-[18px] py-2.5 text-sm font-medium`, the active
 * one in the foreground colour.
 *
 * Which pill is active is the caller's address (`?category`), so Back works and a category can be
 * linked to; `onSelect(undefined)` is All. A key that sits inside More is still the active one —
 * the More pill then wears its label and the active colour, so the state is never hidden behind
 * the menu that holds it.
 */
export type Pill = { key: string; label: string };

const PILL =
  "rounded-full px-[18px] py-2.5 text-sm font-medium transition-colors";
const ACTIVE = "bg-foreground text-background hover:brightness-90";
const INACTIVE = "bg-foreground/[0.03] hover:bg-foreground/[0.07]";

export function Pills({
  items,
  active,
  onSelect,
  moreAfter,
  className,
}: {
  items: readonly Pill[];
  /** The active key; absent is All. */
  active: string | undefined;
  onSelect: (key: string | undefined) => void;
  /** How many pills show before the rest fold into More. Absent shows them all. */
  moreAfter?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const shown =
    moreAfter !== undefined && items.length > moreAfter
      ? items.slice(0, moreAfter)
      : items;
  const folded =
    moreAfter !== undefined && items.length > moreAfter
      ? items.slice(moreAfter)
      : [];
  const foldedActive = folded.find((item) => item.key === active);

  const pill = (key: string | undefined, label: string) => (
    <button
      aria-pressed={active === key}
      className={cn(PILL, active === key ? ACTIVE : INACTIVE)}
      key={key ?? "all"}
      onClick={() => onSelect(key)}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {pill(undefined, t("All"))}
      {shown.map((item) => pill(item.key, item.label))}
      {folded.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-pressed={foldedActive !== undefined}
                className={cn(
                  PILL,
                  "flex items-center gap-1",
                  foldedActive ? ACTIVE : INACTIVE,
                )}
                type="button"
              >
                {foldedActive?.label ?? t("More")}
                <IconChevronDown aria-hidden="true" className="size-4" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              {folded.map((item) => (
                <DropdownMenuItem
                  aria-pressed={active === item.key}
                  key={item.key}
                  onClick={() => onSelect(item.key)}
                >
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
