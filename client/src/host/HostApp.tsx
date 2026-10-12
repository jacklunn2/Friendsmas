import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { HostView } from "../../../shared/types";
import { storage, useRoom } from "../net";
import { ConnectionBanner, Wordmark } from "../ui";
import { ControlRoom } from "./ControlRoom";

const tokenStore = storage("fm.hostToken");

export function HostApp() {
  const [token, setToken] = useState(tokenStore.get());
  const [notice, setNotice] = useState<string | null>(null);

  const signOut = useCallback((message: string | null) => {
    tokenStore.set(null);
    setToken(null);
    setNotice(message);
  }, []);

  if (!token) {
    return (
      <Login
        notice={notice}
        onSignedIn={(t) => {
          tokenStore.set(t);
          setToken(t);
          setNotice(null);
        }}
      />
    );
  }
  return <Connected key={token} token={token} onUnauthorized={signOut} />;
}

function Connected({ token, onUnauthorized }: { token: string; onUnauthorized: (m: string) => void }) {
  const getToken = useMemo(() => () => token, [token]);
  const room = useRoom<HostView>({ role: "host", getToken });
  useEffect(() => {
    if (room.unauthorized) onUnauthorized(room.unauthorized);
  }, [room.unauthorized, onUnauthorized]);
  if (room.unauthorized) return null;
  if (!room.view) {
    return (
      <main className="host host--centre">
        <ConnectionBanner status={room.status} />
        <p className="host__muted">Opening the control room…</p>
      </main>
    );
  }
  return <ControlRoom view={room.view} status={room.status} send={room.send} serverNow={room.serverNow} />;
}

function Login({ notice, onSignedIn }: { notice: string | null; onSignedIn: (token: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(notice);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/host/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error ?? "Couldn't sign in.");
      onSignedIn(body.token);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="host host--centre">
      <form className="login" onSubmit={submit}>
        <Wordmark className="wordmark--host" />
        <h1 className="login__title">Control room</h1>
        <label className="field">
          <span className="field__label">Host password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn--primary btn--block" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
