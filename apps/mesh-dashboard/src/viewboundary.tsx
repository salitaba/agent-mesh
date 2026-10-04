import React from "react";
import { Button, EmptyState } from "./components";

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
  error: Error | null;
}

export class ViewBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // The console has nowhere to report to, and a swallowed error is the worst kind: leave the trail in the devtools.
    console.error("view crashed", error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private details(): string {
    const { error } = this.state;
    return [`Curule console, view: ${this.props.resetKey ?? "unknown"}`, `${error?.name ?? "Error"}: ${error?.message ?? ""}`, error?.stack ?? ""].join("\n");
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        tone="bad"
        icon="alert"
        title="This view stopped drawing"
        action={
          <>
            <Button variant="small" icon="refresh" onClick={() => this.setState({ error: null })}>Try again</Button>
            <Button variant="small" icon="copy" onClick={() => void navigator.clipboard?.writeText(this.details()).catch(() => undefined)}>Copy error details</Button>
          </>
        }
      >
        The rest of the console still works, and the mission is not affected: this is a fault in how the page was drawn, not in
        the mesh. Go to another view, or try again. If it keeps happening, copy the details into a bug report.
        <span className="mono muted view-crash-msg">{this.state.error.message}</span>
      </EmptyState>
    );
  }
}
