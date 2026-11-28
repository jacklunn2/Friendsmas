// Connecting a TV (or any second screen): open friendsmas…/tv, and it shows a
// 4-digit code. Type that code into the control room ("Connect a TV") and this
// screen turns into the stage. It remembers, so next time /tv goes straight there.

import { useEffect, useState } from "react";
import { storage } from "../net";
import { Wordmark } from "../ui";

const remembered = storage("fm.tvEvent");

export function TvPair() {
  const fresh = new URLSearchParams(location.search).has("new");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = remembered.get();
    if (saved && !fresh) {
      location.replace(`/stage?c=${saved}`);
      return;
    }
    let stop = false;
    let pairId = "";
    const begin = async () => {
      try {
        const r = await fetch("/api/tv/pair", { method: "POST" });
        const body = (await r.json()) as { id?: string; code?: string; error?: string };
        if (!r.ok || !body.id || !body.code) throw new Error(body.error ?? "Couldn't get a code.");
        pairId = body.id;
        setCode(body.code);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    const poll = async () => {
      if (stop) return;
      if (pairId) {
        try {
          const r = await fetch(`/api/tv/pair/${pairId}`);
          const body = (await r.json()) as { status: string; eventCode?: string };
          if (body.status === "connected" && body.eventCode) {
            remembered.set(body.eventCode);
            location.replace(`/stage?c=${body.eventCode}`);
            return;
          }
          if (body.status === "expired") {
            pairId = "";
            await begin();
          }
        } catch {
          // Offline for a moment: keep trying.
        }
      } else {
        await begin();
      }
      setTimeout(poll, 2000);
    };
    begin().then(() => setTimeout(poll, 2000));
    return () => {
      stop = true;
    };
  }, [fresh]);

  return (
    <main className="tv-pair">
      <Wordmark className="wordmark--stage" />
      <p className="tv-pair__lede">Connect this screen</p>
      <p className="tv-pair__code" aria-live="polite">
        {code ? code.split("").join(" ") : "· · · ·"}
      </p>
      <ol className="tv-pair__steps">
        <li>Open the control room on your laptop.</li>
        <li>
          Press <strong>Connect a TV</strong> and type this code.
        </li>
      </ol>
      {error && <p className="tv-pair__error">{error} Retrying…</p>}
    </main>
  );
}
