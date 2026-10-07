import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useMesh } from "./store";
import { Switch } from "./components";
import { TURN_ON, notifyAnswer, notifyView, type NotifyState, type NotifyView } from "./notify";
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

/**
 * A small switch row on the Needs you page: what it turns on, and under it in one line what it does and does not do. A browser that
 * will not show notifications (or one that blocks them) leaves the switch where it was and says why when it is pressed.
 */
export function NotifyRow({ atEnd }: { atEnd?: boolean }): React.JSX.Element {
  const { view, press } = useNotify();
  return (
    <div className={`ib-notify${atEnd ? " end" : ""}`}>
      <Switch label={TURN_ON} hint={view.note} checked={view.press === "turn-off"} disabled={view.press === null} title={view.hint} onChange={press} />
    </div>
  );
}
