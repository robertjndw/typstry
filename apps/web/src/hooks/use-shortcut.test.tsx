import { render } from "@testing-library/react";
import { useRef } from "react";

import { IS_MAC } from "@/lib/platform";

import { useShortcuts } from "./use-shortcut";

function Workspace({ onSave }: { onSave: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useShortcuts({ "Mod+S": onSave }, { scope: root });
  return (
    <>
      <div ref={root} data-shortcut-scope="">
        <input aria-label="inside" />
      </div>
      {/* Where Radix portals a dialog: outside the scope. */}
      <div role="dialog">
        <input aria-label="in dialog" />
      </div>
    </>
  );
}

function pressModS(target: Element) {
  const event = new KeyboardEvent("keydown", {
    key: "s",
    code: "KeyS",
    metaKey: IS_MAC,
    ctrlKey: !IS_MAC,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("useShortcuts", () => {
  it("runs inside its scope", () => {
    const onSave = vi.fn();
    const { getByLabelText } = render(<Workspace onSave={onSave} />);
    const event = pressModS(getByLabelText("inside"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves an open dialog alone but still keeps the browser's dialog away", () => {
    const onSave = vi.fn();
    const { getByLabelText } = render(<Workspace onSave={onSave} />);
    const event = pressModS(getByLabelText("in dialog"));
    expect(onSave).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
});
