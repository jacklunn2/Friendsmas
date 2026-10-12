import { useCallback, useEffect, useRef, useState } from "react";
import type { AnyView, Role, ServerMessage } from "../../shared/types";

export type ConnStatus = "connecting" | "open" | "reconnecting";

interface Options {
  role: Role;
  code?: string;
  /** Read when (re)connecting, so a new token doesn't force a reconnect. */
  getToken?: () => string | null;
  enabled?: boolean;
  onWelcome?: (token: string, playerId: string) => void;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * One live connection to the event room. Reconnects on its own, and every
 * request returns a promise that settles when the server answers.
 */
export function useRoom<V extends AnyView>({ role, code, getToken, enabled = true, onWelcome }: Options) {
  const [view, setView] = useState<V | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [unauthorized, setUnauthorized] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const welcomeRef = useRef(onWelcome);
  welcomeRef.current = onWelcome;
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const failAll = (message: string) => {
      for (const p of pending.current.values()) p.reject(new Error(message));
      pending.current.clear();
    };

    const connect = () => {
      const params = new URLSearchParams({ role });
      if (code) params.set("code", code);
      const token = tokenRef.current?.();
      if (token) params.set("token", token);
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?${params}`);
      wsRef.current = ws;
      let refused = false;

      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ a: "ping", rid: "ping" }));
        }, 25_000);
      };

      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "state":
            setClockOffset(msg.view.serverTime - Date.now());
            setView(msg.view as V);
            break;
          case "ok": {
            const p = pending.current.get(msg.rid);
            pending.current.delete(msg.rid);
            p?.resolve(msg.data);
            break;
          }
          case "welcome": {
            welcomeRef.current?.(msg.token, msg.playerId);
            const p = msg.rid ? pending.current.get(msg.rid) : undefined;
            if (msg.rid) pending.current.delete(msg.rid);
            p?.resolve({ playerId: msg.playerId });
            break;
          }
          case "error": {
            const p = msg.rid ? pending.current.get(msg.rid) : undefined;
            if (msg.rid) pending.current.delete(msg.rid);
            p?.reject(new Error(msg.message));
            break;
          }
          case "unauthorized":
            refused = true;
            setUnauthorized(msg.message);
            break;
        }
      };

      ws.onclose = () => {
        clearInterval(ping);
        failAll("The connection dropped. Try again in a moment.");
        if (stopped || refused) return;
        setStatus("reconnecting");
        const delay = Math.min(8000, 500 * 2 ** attempt++);
        retry = setTimeout(connect, delay);
      };
    };

    setUnauthorized(null);
    setStatus("connecting");
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      wsRef.current?.close();
      failAll("Disconnected.");
    };
  }, [role, code, enabled]);

  const send = useCallback(<T = unknown>(action: string, payload?: Record<string, unknown>): Promise<T> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected yet. Try again in a moment."));
    }
    const rid = Math.random().toString(36).slice(2, 10);
    return new Promise<T>((resolve, reject) => {
      pending.current.set(rid, { resolve: resolve as (d: unknown) => void, reject });
      ws.send(JSON.stringify({ a: action, rid, p: payload }));
    });
  }, []);

  /** The server's clock, so countdowns agree across devices. */
  const serverNow = useCallback(() => Date.now() + clockOffset, [clockOffset]);

  return { view, status, unauthorized, send, serverNow };
}

/** Re-renders every `ms` while active; returns the current time. */
export function useTicker(ms: number, active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return now;
}

export function storage(key: string) {
  return {
    get(): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(value: string | null) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // private mode: the session just won't be remembered
      }
    },
  };
}
