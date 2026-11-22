import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui "Base UI" variant of Accordion, restyled to this site's tokens.
 * Pass `keepMounted` on the root so closed answers stay in the HTML for search
 * engines; a base-layer rule in globals.css then shows every answer when
 * JavaScript is off (the preflight's important `[hidden]` rule can only be
 * beaten from the same layer).
 */
function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return <AccordionPrimitive.Root data-slot="accordion" className={cn("flex w-full flex-col", className)} {...props} />;
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("rounded-xl px-5 transition-colors duration-[320ms] data-open:bg-card", className)}
      {...props}
    />
  );
}

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger flex w-full flex-1 items-start gap-4 rounded-md py-2.5 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary aria-disabled:pointer-events-none aria-disabled:opacity-50",
          className,
        )}
        {...props}
      >
        <span className="flex-1 text-[17px] leading-7 font-medium text-pretty text-foreground/85 transition-colors group-aria-expanded/accordion-trigger:text-foreground group-hover/accordion-trigger:text-foreground">
          {children}
        </span>
        {/* A plus whose upright bar turns flat, leaving a minus. */}
        <span
          aria-hidden
          className="relative mt-1 grid size-5 shrink-0 place-items-center text-muted-foreground transition-colors group-hover/accordion-trigger:text-foreground"
        >
          <span className="absolute h-px w-3 bg-current" />
          <span className="absolute h-3 w-px bg-current transition-transform duration-[320ms] ease-out group-aria-expanded/accordion-trigger:rotate-90" />
        </span>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    // The panel owns the animation: `data-starting-style`/`data-ending-style` land on
    // this element, so the height (from Base UI's measured panel-height variable) and
    // opacity transition here — 320ms opening, a quicker 240ms closing.
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className={cn(
        "h-(--accordion-panel-height) overflow-hidden opacity-100 transition-[height,opacity] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-ending-style:h-0 data-ending-style:opacity-0 data-ending-style:duration-[240ms] data-starting-style:h-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    >
      <p className="max-w-[68ch] pr-9 pb-6 text-base leading-relaxed text-pretty text-muted-foreground [overflow-wrap:anywhere] sm:pr-11">
        {children}
      </p>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
