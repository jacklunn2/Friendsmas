// The House vs the teams (Block 4). The House's score sits behind a vault
// door, then swings open; each team is stamped in turn; then the verdict.

import { useEffect, useMemo, useState } from "react";
import { formatNumber, signed, teamDisplayName, type StageView } from "../../../shared/types";
import { audioOn, sfx } from "../audio";
import { playerMap, teamStyle, Avatar } from "../ui";

const OPEN_MS = 3200;
const STEP_MS = 900;

export function HouseFaceOff({ view }: { view: StageView }) {
  const r = view.houseReveal!;
  const a = view.activities.find((x) => x.id === r.activityId);
  const teams = useMemo(() => new Map(view.teams.map((t) => [t.id, t])), [view.teams]);
  const players = useMemo(() => playerMap(view.players), [view.players]);
  const [stage, setStage] = useState(0);
  const verdictAt = OPEN_MS + r.rows.length * STEP_MS + 600;

  useEffect(() => {
    const timers = [
      setTimeout(() => setStage(1), OPEN_MS),
      setTimeout(() => setStage(2), verdictAt),
    ];
    if (audioOn()) {
      sfx.drumroll(OPEN_MS / 1000 - 0.4);
      timers.push(setTimeout(() => sfx.thud(), OPEN_MS));
      r.rows.forEach((row, i) => timers.push(setTimeout(() => (row.beat ? sfx.chime() : sfx.thud()), OPEN_MS + (i + 1) * STEP_MS)));
      timers.push(setTimeout(() => (r.houseWins ? sfx.buzzer() : sfx.fanfare()), verdictAt));
    }
    return () => timers.forEach(clearTimeout);
    // Once per showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beaten = r.rows.filter((x) => x.beat).length;

  return (
    <section className={`scene faceoff${r.houseWins && stage === 2 ? " is-house-win" : ""}`}>
      <header className="faceoff__head">
        <p className="faceoff__kicker">{a?.name ?? "Beat the House"}</p>
        <h1 className="faceoff__title">Beat the House</h1>
        <p className="faceoff__rule">{r.direction === "high" ? "Highest score wins" : "Lowest score wins"} · the House wins ties</p>
      </header>

      <div className="faceoff__house">
        <div className={`vault${stage >= 1 ? " is-open" : ""}`}>
          <div className="vault__inside">
            <span className="vault__label">The House scored</span>
            <span className="vault__score">{formatNumber(r.houseScore)}</span>
          </div>
          <div className="vault__door" aria-hidden>
            <span className="vault__wheel">🏠</span>
            <span className="vault__q">?</span>
          </div>
        </div>
      </div>

      <ol className="faceoff__teams">
        {r.rows.map((row, i) => {
          const t = teams.get(row.teamId);
          if (!t) return null;
          return (
            <li key={row.teamId} className={`faceoff-row${stage >= 1 ? (row.beat ? " is-beat" : " is-beaten") : ""}`} style={{ ...teamStyle(t), animationDelay: `${i * 150}ms` }}>
              <span className="faceoff-row__team">
                {teamDisplayName(t)}
                <span className="faceoff-row__faces">
                  {t.memberIds.map((id) => {
                    const p = players.get(id);
                    return p ? <Avatar key={id} player={p} className="faceoff-row__face" /> : null;
                  })}
                </span>
              </span>
              <span className="faceoff-row__score">{row.score === null ? "–" : formatNumber(row.score)}</span>
              {stage >= 1 && (
                <span className="faceoff-row__stamp" style={{ animationDelay: `${(i + 1) * STEP_MS}ms` }}>
                  {row.beat ? `Beat it! ${signed(r.teamPoints)}` : "Beaten"}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {stage >= 2 && (
        <p className={`faceoff__verdict${r.houseWins ? " is-house" : ""}`} role="status">
          {r.houseWins
            ? `The House always wins. ${r.housePoints ? `${signed(r.housePoints)} to the House` : ""}`
            : `${beaten} ${beaten === 1 ? "team beats" : "teams beat"} the House!`}
        </p>
      )}
    </section>
  );
}
