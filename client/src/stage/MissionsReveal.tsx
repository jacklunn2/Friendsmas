// The finale reveal of every secret mission (Block 4): a wall of case files,
// each stamped as it lands. Pulled-off missions come first.

import { useEffect, useMemo, type CSSProperties } from "react";
import type { MissionStatus, StageView } from "../../../shared/types";
import { audioOn, sfx } from "../audio";
import { Avatar, playerMap } from "../ui";

const STAMP: Record<MissionStatus, string> = { completed: "Accomplished", noticed: "Failed", active: "Never tried" };
const STEP_MS = 900;

export function MissionsReveal({ view }: { view: StageView }) {
  const players = useMemo(() => playerMap(view.players), [view.players]);
  const rows = (view.missionsReveal ?? []).filter((r) => players.has(r.playerId));
  const done = rows.filter((r) => r.status === "completed").length;
  const cols = rows.length <= 4 ? 2 : rows.length <= 9 ? 3 : 4;

  useEffect(() => {
    if (!audioOn()) return;
    const timers = rows.map((r, i) => setTimeout(() => (r.status === "completed" ? sfx.chime() : sfx.thud()), i * STEP_MS + 500));
    return () => timers.forEach(clearTimeout);
    // Once per showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className={`scene missions-reveal${rows.length > 9 ? " is-dense" : ""}`}>
      <header className="missions-reveal__head">
        <p className="missions-reveal__kicker">Declassified</p>
        <h1 className="missions-reveal__title">
          The secret missions · {done} of {rows.length} pulled off
        </h1>
      </header>
      <ul className="missions-reveal__grid" style={{ "--cols": cols } as CSSProperties}>
        {rows.map((r, i) => {
          const p = players.get(r.playerId)!;
          return (
            <li key={r.playerId} className={`dossier dossier--${r.status}`} style={{ animationDelay: `${i * STEP_MS}ms` }}>
              <Avatar player={p} className="dossier__photo" />
              <span className="dossier__name">{p.name}</span>
              <p className="dossier__text">{r.text}</p>
              <span className="dossier__stamp" style={{ animationDelay: `${i * STEP_MS + 450}ms` }}>
                {STAMP[r.status]}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
