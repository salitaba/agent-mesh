/* What Escape means in the phone drawer.
 *
 * The shell owns Escape and, for a focused input, select or textarea, it blurs the field and prevents the default before any view's
 * window handler sees the key ("This sits BELOW the text-input guard on purpose", shell.tsx). That is right for a field in a page, and
 * wrong for a field in a drawer that covers the whole phone: the first Escape only dropped focus on <body> and left the full-screen
 * drawer up (it used to open on its first field; it now opens on its heading, for the phone keyboard, so the window handler blurs
 * nothing — but a person who has tabbed into a field hits the same rule). The drawer therefore handles Escape on its own container,
 * where the field's handler has already run: a seat id that reverts its draft on Escape keeps the drawer open, and every other press
 * closes it. */

export interface EscapePress {
  key: string;
  defaultPrevented: boolean;
}

/** Whether a press inside the drawer should close it. On a wide screen the inspector is a column, not a layer, so it never does. */
export function drawerTakesEscape(press: EscapePress, compact: boolean, open: boolean): boolean {
  return open && compact && press.key === "Escape" && !press.defaultPrevented;
}
