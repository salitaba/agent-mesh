/**
 * Where a tooltip goes. DOM-free: the component measures the trigger, the tip and the window and asks here.
 *
 * It sits on the side it was asked for, centred on the trigger along the other axis. If that side has no room and the opposite
 * one has, it flips (a tooltip under the top bar's edge goes below its control, not off the screen). Along the other axis it is
 * kept inside the window by a margin, so a control at the corner does not push its label out of sight.
 */

export type Side = "top" | "bottom" | "left" | "right";
export interface Box { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

export function tipPosition(trigger: Box, tip: Size, view: Size, side: Side = "top", gap = 8, margin = 8): { left: number; top: number; side: Side } {
  const room: Record<Side, number> = {
    top: trigger.top - margin,
    bottom: view.height - (trigger.top + trigger.height) - margin,
    left: trigger.left - margin,
    right: view.width - (trigger.left + trigger.width) - margin,
  };
  const need = (s: Side): number => (s === "top" || s === "bottom" ? tip.height : tip.width) + gap;
  const placed: Side = room[side] >= need(side) || room[OPPOSITE[side]] < need(OPPOSITE[side]) ? side : OPPOSITE[side];

  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  let left: number;
  let top: number;
  if (placed === "top" || placed === "bottom") {
    left = clamp(trigger.left + trigger.width / 2 - tip.width / 2, margin, view.width - tip.width - margin);
    top = placed === "top" ? trigger.top - tip.height - gap : trigger.top + trigger.height + gap;
  } else {
    top = clamp(trigger.top + trigger.height / 2 - tip.height / 2, margin, view.height - tip.height - margin);
    left = placed === "left" ? trigger.left - tip.width - gap : trigger.left + trigger.width + gap;
  }
  return { left: Math.round(left), top: Math.round(top), side: placed };
}
