"use client"

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

function Accordion(props: AccordionPrimitive.Root.Props) {
  return <AccordionPrimitive.Root {...props} />
}

function AccordionItem({
  className,
  ...props
}: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b last:border-b-0", className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header>
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "flex w-full items-center justify-between py-3 px-2 text-sm font-semibold hover:bg-muted/40 rounded-md [&[data-panel-open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        <>
          {children}
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
        </>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className={cn("overflow-hidden text-sm", className)}
      {...props}
    >
      <div className="pb-4">{children as React.ReactNode}</div>
    </AccordionPrimitive.Panel>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
