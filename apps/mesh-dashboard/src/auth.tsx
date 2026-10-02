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
 * Fails open in the UI only. If the status route is missing or unreachable (an older server, a
 * dev proxy) the console is shown, and the server's own 401s are what protect it: the gate is
 * how an operator gets in, not what keeps anyone out.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button, Card, Input } from "./components";
import { onAuthRequired } from "./api";

type Phase = "checking" | "open" | "login";

interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}

export interface AuthValue {
  /** The server holds a token, so there is a session to end. */
  required: boolean;
  signOut: () => void;
}

const AuthCtx = createContext<AuthValue | null>(null);

/** Null outside the gate (tests, an embedded view); the sign-out control simply is not offered. */
export const useAuthOptional = (): AuthValue | null => useContext(AuthCtx);

async function readStatus(): Promise<AuthStatus | null> {
  try {
    const res = await fetch("/auth/status");
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<AuthStatus>;
    return typeof body.required === "boolean" ? { required: body.required, authenticated: body.authenticated === true } : null;
  } catch {
    return null;
  }
}

export function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("checking");
  const [required, setRequired] = useState(false);
  // Bumped on sign-in so everything under the gate mounts afresh and refetches with its new cookie.
  const [epoch, setEpoch] = useState(0);
  const rechecking = useRef(false);

  useEffect(() => {
    let alive = true;
    void readStatus().then((s) => {
      if (!alive) return;
      setRequired(s?.required ?? false);
      setPhase(!s || !s.required || s.authenticated ? "open" : "login");
    });
    return () => {
      alive = false;
    };
  }, []);

  // A 401 from any call means the session ended. Ask before covering the console: one stray 401 (a
  // child that rejected the host's token) is not a reason to sign the operator out, and a burst of
  // them is one question, not forty.
  useEffect(
    () =>
      onAuthRequired(() => {
        if (rechecking.current) return;
        rechecking.current = true;
        void readStatus()
          .then((s) => {
            if (s && s.required && !s.authenticated) {
              setRequired(true);
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
      .finally(() => setPhase("login"));
  }, []);

  if (phase === "checking") return <div className="empty">loading…</div>;
  if (phase === "login") {
    return (
      <SignIn
        onSignedIn={() => {
          setRequired(true);
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

function SignIn({ onSignedIn }: { onSignedIn: () => void }): React.JSX.Element {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault();
    if (busy || !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (res.ok) {
        // Not kept: from here the cookie is the credential, and script cannot read it.
        setToken("");
        onSignedIn();
        return;
      }
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after"));
        setError(`Too many wrong tokens from this address. Try again${wait > 0 ? ` in ${wait} second${wait === 1 ? "" : "s"}` : " shortly"}.`);
      } else if (res.status === 401) {
        setError("That token was not accepted.");
      } else {
        setError(`The server answered ${res.status}. Is it still running?`);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <form onSubmit={(ev) => void submit(ev)} aria-labelledby="signin-title">
        <Card title={<span id="signin-title">Sign in to Ordane</span>}>
          <p className="muted">This server is protected by an access token. It is the value of <span className="mono">MESH_API_TOKEN</span> the server was started with.</p>
          <label htmlFor="signin-token">Access token</label>
          <Input
            id="signin-token"
            type="password"
            mono
            autoComplete="current-password"
            autoFocus
            spellCheck={false}
            value={token}
            onChange={(ev) => setToken(ev.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
          />
          {error ? (
            <div id="signin-error" className="signin-error" role="alert">
              {error}
            </div>
          ) : null}
          <div className="signin-actions">
            <Button variant="primary" type="submit" disabled={busy || !token.trim()}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </Card>
      </form>
    </main>
  );
}
