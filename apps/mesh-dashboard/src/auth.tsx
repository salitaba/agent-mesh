/**
 * Sign-in gate.
 *
 * A server that holds an access token answers every API call with 401 until the browser has
 * traded that token, once, for a session cookie (`POST /auth/login`, see
 * apps/mesh-server/src/auth.ts). This component asks `GET /auth/status` first and shows the
 * console only when the server says this browser may have it. The token is typed into a password
 * field, sent once, and not kept: the page never holds a credential after the request, and the
 * cookie that results is HttpOnly, so nothing on the page can read it either.
 *
 * What each answer means, and every sentence the page says about it, is in signin.ts (DOM-free,
 * tested). Four things the gate can be showing:
 *
 *   checking     one request, a moment
 *   unreachable  the host did not answer (down, starting, wrong address): it asks again by itself
 *   login        the sign-in page, first visit or, with a sentence saying so, after a session ended
 *   open         the console
 *
 * Fails open in the UI only. If the status route is missing (an older server, a dev proxy) the
 * console is shown, and the server's own 401s are what protect it: the gate is how an operator
 * gets in, not what keeps anyone out.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import "./firstrun.css";
import { Banner, Button, IconTile, Wordmark } from "./components";
import { Icon } from "./icons";
import { onAuthRequired } from "./api";
import {
  SESSION_ENDED,
  TOKEN_FIRST,
  TOKEN_SOURCES,
  classifyLogin,
  connectionWarning,
  normalizeToken,
  readGate,
  secondsLeft,
  splitSentence,
  type SignInOutcome,
} from "./signin";

type Phase = "checking" | "open" | "login" | "unreachable";

export interface AuthValue {
  /** The server holds a token, so there is a session to end. */
  required: boolean;
  signOut: () => void;
}

const AuthCtx = createContext<AuthValue | null>(null);

/** Null outside the gate (tests, an embedded view); the sign-out control simply is not offered. */
export const useAuthOptional = (): AuthValue | null => useContext(AuthCtx);

async function readStatus(): Promise<{ kind: "open" | "login" | "unreachable"; required: boolean }> {
  let res: Response;
  try {
    res = await fetch("/auth/status");
  } catch {
    return { kind: readGate(null).kind, required: false };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: readGate treats an answer that is not the shape asked for as an older server */
  }
  return { kind: readGate({ status: res.status, body }).kind, required: (body as { required?: unknown } | null)?.required === true };
}

/** The page's heading and title for the states that are not the sign-in form: the wordmark and a short card. */
function GateCard({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="si">
      <div className="si-wrap">
        <div className="si-logo"><Wordmark height={30} /></div>
        {children}
      </div>
    </main>
  );
}

function Checking(): React.JSX.Element {
  return (
    <GateCard>
      <section className="si-card si-state" aria-labelledby="gate-title">
        <IconTile icon="host" tone="neutral" />
        <h1 id="gate-title">Curule</h1>
        <p role="status">Checking the host…</p>
      </section>
    </GateCard>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <GateCard>
      <section className="si-card si-state" aria-labelledby="gate-title">
        <IconTile icon="alert" tone="bad" />
        <h1 id="gate-title">Cannot reach the host</h1>
        <p>
          This page asked the host at <b className="mono">{window.location.host}</b> whether it needs a sign-in, and it did not answer. Check that it is
          running and that this address is right. This page asks again every few seconds, and you can ask now.
        </p>
        <Button variant="primary" icon="refresh" onClick={onRetry}>Try again</Button>
      </section>
    </GateCard>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("checking");
  const [required, setRequired] = useState(false);
  /** The sign-in page is showing because a session ended under someone who was using the console. */
  const [ended, setEnded] = useState(false);
  // Bumped on sign-in so everything under the gate mounts afresh and refetches with its new cookie.
  const [epoch, setEpoch] = useState(0);
  const rechecking = useRef(false);

  const check = useCallback(async (): Promise<void> => {
    const s = await readStatus();
    setRequired(s.required);
    setPhase(s.kind);
  }, []);

  useEffect(() => {
    let alive = true;
    void readStatus().then((s) => {
      if (!alive) return;
      setRequired(s.required);
      setPhase(s.kind);
    });
    return () => {
      alive = false;
    };
  }, []);

  // A host that is starting, or restarting under a proxy, answers in a few seconds: ask again by itself, so the page is
  // the sign-in form when the host is up without anyone pressing anything.
  useEffect(() => {
    if (phase !== "unreachable") return;
    const iv = setInterval(() => void check(), 4000);
    return () => clearInterval(iv);
  }, [phase, check]);

  // A 401 from any call means the session ended. Ask before covering the console: one stray 401 (a
  // child that rejected the host's token) is not a reason to sign the operator out, and a burst of
  // them is one question, not forty. A host that does not answer the question is not a reason either:
  // the console says that itself.
  useEffect(
    () =>
      onAuthRequired(() => {
        if (rechecking.current) return;
        rechecking.current = true;
        void readStatus()
          .then((s) => {
            if (s.kind === "login") {
              setRequired(true);
              setEnded(true);
              setPhase("login");
            }
          })
          .finally(() => {
            rechecking.current = false;
          });
      }),
    [],
  );

  const signOut = useCallback(() => {
    void fetch("/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .catch(() => undefined)
      .finally(() => {
        // Deliberate: no "your session ended" for a person who just ended it.
        setEnded(false);
        setPhase("login");
      });
  }, []);

  if (phase === "checking") return <Checking />;
  if (phase === "unreachable") return <Unreachable onRetry={() => void check()} />;
  if (phase === "login") {
    return (
      <SignIn
        ended={ended}
        onSignedIn={() => {
          setRequired(true);
          setEnded(false);
          setEpoch((e) => e + 1);
          setPhase("open");
        }}
      />
    );
  }
  return (
    <AuthCtx.Provider value={{ required, signOut }}>
      <React.Fragment key={epoch}>{children}</React.Fragment>
    </AuthCtx.Provider>
  );
}

function SignIn({ ended, onSignedIn }: { ended: boolean; onSignedIn: () => void }): React.JSX.Element {
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Exclude<SignInOutcome, { kind: "signed-in" }> | null>(null);
  /** Sign in was pressed with the field empty. */
  const [empty, setEmpty] = useState(false);
  /** When a rate limit ends, in ms since the epoch, and the clock the countdown reads. */
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const warning = connectionWarning(window.location.protocol, window.location.hostname);

  const wait = until === null ? 0 : secondsLeft(until, now);
  const limited = wait > 0;
  const retryable = failure?.kind === "unreachable" || failure?.kind === "server-error";

  // The tab says where you are: the shell sets its own title once you are in.
  useEffect(() => {
    const before = document.title;
    document.title = "Sign in - Curule";
    return () => {
      document.title = before;
    };
  }, []);

  // One tick a second while a limit runs, and none after.
  useEffect(() => {
    if (until === null) return;
    const iv = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) clearInterval(iv);
    }, 1000);
    return () => clearInterval(iv);
  }, [until]);

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault();
    const typed = normalizeToken(token);
    if (busy || limited) return;
    if (!typed) {
      // Answered where the person is looking, with the cursor back in the field.
      setEmpty(true);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setEmpty(false);
    setFailure(null);
    let attempt: Parameters<typeof classifyLogin>[0];
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: typed }),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* a proxy's error page is not JSON; the status says enough */
      }
      attempt = { status: res.status, retryAfter: res.headers.get("retry-after"), body };
    } catch {
      attempt = null;
    }
    const outcome = classifyLogin(attempt);
    setBusy(false);
    if (outcome.kind === "signed-in") {
      // Not kept: from here the cookie is the credential, and script cannot read it.
      setToken("");
      onSignedIn();
      return;
    }
    setFailure(outcome);
    if (outcome.kind === "rate-limited") {
      const t = Date.now();
      setNow(t);
      setUntil(t + outcome.seconds * 1000);
    }
    // A mistyped token is fixed where it is: the field keeps it, selected.
    if (outcome.kind === "wrong-token") {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  const label = busy ? "Signing in…" : limited ? `Try again in ${wait} s` : retryable ? "Try again" : "Sign in";
  const told = failure ? splitSentence(failure.message) : null;
  const liftedLimit = failure?.kind === "rate-limited" && !limited;

  return (
    <main className="si">
      <div className="si-wrap">
        <div className="si-logo"><Wordmark height={30} /></div>
        <section className="si-card" aria-labelledby="signin-title">
          <h1 id="signin-title">Sign in to Curule</h1>
          <p className="si-lede">Curule runs teams of AI agents as one organization. Sign in with this host's access token to open its console.</p>
          {ended ? <Banner tone="info" icon="lock" title={SESSION_ENDED} /> : null}
          {warning ? <Banner tone="warn" title={splitSentence(warning).title}>{splitSentence(warning).detail}</Banner> : null}
          <form className="si-form" onSubmit={(ev) => void submit(ev)} noValidate>
            {/* A name for a password manager to keep the token under. Nobody else needs it. */}
            <input type="text" name="username" autoComplete="username" value="operator" readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
            <label htmlFor="signin-token">Access token</label>
            <div className="si-field">
              <input
                id="signin-token"
                ref={inputRef}
                className="txt mono"
                name="password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={token}
                onChange={(ev) => {
                  setToken(ev.target.value);
                  setEmpty(false);
                }}
                aria-invalid={failure?.kind === "wrong-token" || empty ? true : undefined}
                aria-describedby={empty ? "signin-empty" : failure || liftedLimit ? "signin-error" : undefined}
              />
              <button type="button" className="si-eye" aria-label={show ? "Hide token" : "Show token"} aria-pressed={show} onClick={() => setShow(!show)}>
                <Icon name={show ? "eye-off" : "eye"} size={18} />
              </button>
            </div>
            {empty ? (
              <p id="signin-empty" className="si-hint" role="alert">
                <Icon name="alert" size={14} />
                <span>{TOKEN_FIRST}</span>
              </p>
            ) : null}
            {failure && !liftedLimit && told ? (
              <div id="signin-error">
                <Banner tone="bad" title={told.title}>{told.detail}</Banner>
              </div>
            ) : null}
            {liftedLimit ? (
              <div id="signin-error">
                <Banner tone="info" title="You can try again now." />
              </div>
            ) : null}
            <Button variant="primary" size="lg" type="submit" extra="si-submit" loading={busy} disabled={limited}>
              {label}
            </Button>
          </form>
          <details className="si-help">
            <summary>
              <Icon name="chevron-right" size={14} />
              Where do I find the token?
            </summary>
            <ul className="si-sources">
              {TOKEN_SOURCES.map((s) => (
                <li key={s.id}>
                  <b>{s.title}</b>
                  <p>{s.where.map((piece, i) => (typeof piece === "string" ? <React.Fragment key={i}>{piece}</React.Fragment> : <code key={i}>{piece.code}</code>))}</p>
                  {s.command ? <code className="si-cmd">{s.command}</code> : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
        <p className="si-foot">
          <Icon name="lock" size={14} />
          <span>Signing in to <b>{window.location.host}</b>. The token is sent once and traded for a session cookie; this page does not keep it.</span>
        </p>
      </div>
    </main>
  );
}
