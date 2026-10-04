/**
 * Copy text to the clipboard, and say whether it worked.
 *
 * `navigator.clipboard` exists only in a secure context: https, or localhost. A mesh host that is opened over plain http from
 * another machine (which is how a self-hosted console gets opened) has none, and the copy buttons used to report that the
 * browser had blocked them. The old `execCommand("copy")` still works there when it is called from a user gesture, so it is the
 * fallback, and failure is reported only when both fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection route */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off screen rather than hidden: a display:none field cannot be selected.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  // Selecting the field moved focus; a keyboard user must land back where they were.
  active?.focus();
  return ok;
}
