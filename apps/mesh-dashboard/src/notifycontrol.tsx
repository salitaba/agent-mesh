import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useMesh } from "./store";
import { Button } from "./components";
import { notifyAnswer, notifyView, type NotifyState, type NotifyView } from "./notify";
import { notifySnapshot, pressNotify, subscribeNotify } from "./notifyclient";

/**
 * The switch for desktop notifications, for the two places a person looks for it: the Needs you page, which is where they are
 * when a decision waits, and the top bar's "..." menu, which is one tap away from every page. What it says in each state is
 * notify.ts's; what pressing it does is notifyclient.ts's. This only joins them to a button.
 */
export function useNotify(): { view: NotifyView; press: () => void } {
  const { toast } = useMesh();
  const snap = useSyncExternalStore(subscribeNotify, notifySnapshot, () => '{"kind":"off"}');
  const view = useMemo(() => notifyView(JSON.parse(snap) as NotifyState), [snap]);
  const what = view.press;
  const press = useCallback(() => {
    if (!what) return;
    // Called in the click itself, so the browser's permission prompt has the gesture it needs.
    void pressNotify(what).then((answer) => {
      const a = notifyAnswer(what, answer);
      toast(a.title, a.msg, a.kind);
    });
  }, [what, toast]);
  return { view, press };
}

/** A quiet line on the Needs you page: the button, and in one line what it does and what it does not. */
export function NotifyRow({ atEnd }: { atEnd?: boolean }): React.JSX.Element {
  const { view, press } = useNotify();
  return (
    <div className={`ib-notify${atEnd ? " end" : ""}`}>
      {view.press ? <Button variant="small" icon="bell" title={view.hint} aria-describedby="ib-notify-note" onClick={press}>{view.label}</Button> : null}
      <p className="ib-notify-note" id="ib-notify-note">{view.note}</p>
    </div>
  );
}
