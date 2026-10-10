import { cn } from "cn";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-sm border bg-muted px-1 font-sans text-[0.7rem] font-medium text-muted-foreground select-none",
        "[[data-slot=tooltip-content]_&]:border-background/20 [[data-slot=tooltip-content]_&]:bg-background/10 [[data-slot=tooltip-content]_&]:text-background",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
