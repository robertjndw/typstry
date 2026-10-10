import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { shortcutKeys } from "@/lib/platform";

/** A combo like "Mod+B" as key caps for this platform. */
export function ShortcutKeys({
  combo,
  className,
}: {
  combo: string;
  className?: string;
}) {
  return (
    <KbdGroup className={className}>
      {shortcutKeys(combo).map((key, i) => (
        <Kbd key={i}>{key}</Kbd>
      ))}
    </KbdGroup>
  );
}
