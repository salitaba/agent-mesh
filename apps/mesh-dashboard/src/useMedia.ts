import { useEffect, useState } from "react";

/** Whether a media query holds now, and re-renders when it stops or starts holding. The pages that move a panel beside or below
 *  the list ask this instead of measuring, so the answer is the one CSS would give. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const sync = (): void => setOn(m.matches);
    m.addEventListener("change", sync);
    sync();
    return () => m.removeEventListener("change", sync);
  }, [query]);
  return on;
}

/** The console's two-column break (styles.css collapses `.grid.two` at 1100px): wider than this, a list and its panel sit side by side. */
export const WIDE = "(min-width: 1101px)";
