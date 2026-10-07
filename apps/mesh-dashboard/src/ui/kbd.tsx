import type { ReactNode } from "react";
import { chordParts } from "./keys";

/** Whether this machine's modifier is ⌘. The one place that asks; the table that uses the answer is keys.ts. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

/**
 * A key, or a chord drawn as its caps. `<Kbd keys="mod+k" />` is ⌘ K on a Mac and Ctrl K on any other machine; `<Kbd>Esc</Kbd>`
 * is exactly what you wrote. A chord is one <kbd> per cap in a `.keys` group, so a container pushes the whole group, not each cap.
 */
export function Kbd({ keys, children }: { keys?: string; children?: ReactNode }): React.JSX.Element {
  if (keys === undefined) return <kbd>{children}</kbd>;
  return <span className="keys">{chordParts(keys, isMac()).map((cap, i) => <kbd key={i}>{cap}</kbd>)}</span>;
}
