import React from "react";
import { Button, CopyButton, EmptyState } from "./components";
import { crashHeadline, crashReport, isStaleBundle } from "./crash";

/**
 * One view's failure stays one view's failure.
 *
 * React unmounts the whole tree when a component throws while rendering, so before this a single bad payload in the step
 * ledger, or a field a newer server added and an older view did not expect, blanked the entire console: sidebar, top bar,
 * the way to another view and the way to a working mission. This sits around the view only. The shell stays, the person can
 * go somewhere else, and the error can be copied into a bug report instead of being lost with the page.
 *
 * `resetKey` is the view's name: moving to another view clears the error, so one broken view does not make the next one
 * look broken too.
 */
interface Props {
  children: React.ReactNode;
  resetKey?: string;
}

interface State {
  error: unknown;
  failed: boolean;
  componentStack: string | null;
}

const OK: State = { error: null, failed: false, componentStack: null };

export class ViewBoundary extends React.Component<Props, State> {
  override state: State = OK;

  // `failed` is its own flag because anything can be thrown, including a falsy value, and "was there an error" must not depend on it.
  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // The console has nowhere to report to, and a swallowed error is the worst kind: leave the trail in the devtools.
    console.error("view crashed", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState(OK);
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    const { error, componentStack } = this.state;

    // The page itself is old: the host was updated after this tab loaded and the view's file is gone. Retrying cannot help.
    if (isStaleBundle(error)) {
      return (
        <EmptyState
          icon="refresh"
          title="The console was updated"
          action={<Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload the console</Button>}
        >
          This page is from before the host was updated, and the part of it you asked for is no longer on the server. Reloading
          fetches the new version and keeps you on the same project and view.
        </EmptyState>
      );
    }

    return (
      <EmptyState
        tone="bad"
        icon="alert"
        title="This view stopped drawing"
        action={
          <>
            <Button variant="small" icon="refresh" onClick={() => this.setState(OK)}>Try again</Button>
            <CopyButton label="Copy error details" text={crashReport({ view: this.props.resetKey ?? "", route: window.location.hash, error, componentStack })} />
          </>
        }
      >
        The rest of the console still works, and the mission is not affected: this is a fault in how the page was drawn, not in
        the mesh. Go to another view, or try again. If it keeps happening, copy the details into a bug report.
        <span className="mono muted view-crash-msg">{crashHeadline(error)}</span>
      </EmptyState>
    );
  }
}

/**
 * What the view area shows while something it needs is still on its way: a lazily loaded view's file, or the host's list of
 * projects on first paint. It stays invisible for the first moment, so a view that loads at once does not flash a grey frame, and
 * has the shape of a page (a title, a line, three blocks) so what replaces it does not jump. It says so in words as well: grey
 * blocks alone, on a slow link, read as a page that came out blank.
 */
export function ViewLoading(): React.JSX.Element {
  return (
    <div className="view-loading" role="status" aria-busy="true">
      <p className="view-loading-text">Loading this page…</p>
      <span className="sk view-loading-title" aria-hidden="true" />
      <span className="sk view-loading-line" aria-hidden="true" />
      <div className="view-loading-blocks" aria-hidden="true">
        <span className="sk" />
        <span className="sk" />
        <span className="sk" />
      </div>
    </div>
  );
}
