import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { createContext, useContext } from "react";

import { cn } from "@/lib/utils";

/**
 * Tabs on Base UI, in the two shapes this app draws.
 *
 * `segmented` is the pill: a rounded track in the muted surface with the selected tab lifted onto
 * the card colour (the bot panel's Details | Library | Computer). `underline` is the row of labels
 * with a hairline under the selected one (the Marketplace's Apps | Skills | Agents). Base UI owns
 * the behaviour, roving focus with the arrow keys, `aria-selected`, `aria-controls` and the panel
 * wiring, so the two variants differ only in class names, carried from the list to its triggers
 * through context rather than repeated at every call site.
 */
type TabsVariant = "segmented" | "underline";

const TabsVariantContext = createContext<TabsVariant>("segmented");

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-3", className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  variant = "segmented",
  ...props
}: TabsPrimitive.List.Props & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(
          "flex items-center",
          variant === "segmented"
            ? "h-9 w-fit rounded-full bg-muted p-1"
            : "gap-6 border-b border-border",
          className,
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  const variant = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      data-variant={variant}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-none transition-[color,background-color,border-color] duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variant === "segmented"
          ? "h-full flex-1 rounded-full px-3 text-sm text-muted-foreground data-active:bg-card data-active:text-foreground"
          : "-mb-px h-10 border-b-2 border-transparent px-1 text-[15px] text-muted-foreground hover:text-foreground data-active:border-foreground data-active:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsPanel };
export type { TabsVariant };
