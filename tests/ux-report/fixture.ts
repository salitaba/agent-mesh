/**
 * Snapshots for the ux-report tests, built by hand rather than rendered.
 *
 * That is the point of the split this package makes: the browser only collects, and everything that
 * decides something is a pure function of the collected data. A fixture is therefore a real input — the
 * same one the image smoke test produces — and these tests run in CI, where no Chromium exists.
 */
import type { PageSnapshot, VisualNode } from "../../packages/ux-report/src/index";

/** A laid-out element with everything unremarkable, so a test states only what it is about. */
export function node(partial: Partial<VisualNode> & { path: string }): VisualNode {
  return {
    tag: "div",
    name: undefined,
    role: undefined,
    box: { x: 0, y: 0, width: 100, height: 100 },
    fontFamily: "system-ui, sans-serif",
    fontSize: 16,
    fontWeight: 400,
    lineHeight: 24,
    color: "rgb(0, 0, 0)",
    background: "rgba(0, 0, 0, 0)",
    backgroundBehind: "rgb(255, 255, 255)",
    backgroundOutside: "rgb(255, 255, 255)",
    radius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    borders: [],
    interactive: false,
    focusRing: null,
    ...partial,
  };
}

/** A control: interactive, 44×44, with a ring — a test moves the one thing it is about. */
export function control(partial: Partial<VisualNode> & { path: string }): VisualNode {
  return node({
    ...partial,
    tag: partial.tag ?? "button",
    role: partial.role ?? "button",
    interactive: true,
    focusRing: partial.focusRing === undefined ? { width: 2, color: "rgb(0, 0, 0)", from: "outline" } : partial.focusRing,
    box: partial.box ?? { x: 0, y: 0, width: 88, height: 44 },
  });
}

export function page(nodes: VisualNode[], partial: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "file:///tmp/fixture.html",
    title: "Fixture",
    part: "Fixture",
    viewport: { width: 390, height: 844 },
    scrollWidth: 390,
    clientWidth: 390,
    nodes,
    ...partial,
  };
}
