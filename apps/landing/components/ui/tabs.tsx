"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui "Base UI" variant of Tabs, restyled to this site's tokens and
 * without the variant machinery (this site uses one look). `orientation` is
 * forwarded to the root so arrow-key movement follows the visual layout.
 */
function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      className={cn("group/tabs flex flex-col", className)}
      {...props}
    />
  );
}

/** The list is `relative` so Base UI's indicator can sit on the active tab. */
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("relative flex text-muted-foreground", className)} {...props} />;
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "group/tab relative z-10 inline-flex items-center justify-center rounded-md px-3 py-1.5 font-mono text-[13px] whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The sliding highlight. Base UI measures the active tab and writes
 * `--active-tab-top/left/width/height` on this element; pass
 * `renderBeforeHydration` so the first paint already shows it in place.
 */
function TabsIndicator({ className, ...props }: TabsPrimitive.Indicator.Props) {
  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      className={cn(
        "absolute top-(--active-tab-top) left-(--active-tab-left) h-(--active-tab-height) w-(--active-tab-width) rounded-md bg-muted transition-[top,left,width,height] duration-200",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn("flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsIndicator, TabsContent };
