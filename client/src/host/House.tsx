// "Beat the House" in the control room (Block 4). Before the round, lock in
// the House's score (it stays hidden until the face-off). Record each team's
// score (quizzes and polls use the points earned), then settle it on the TV.

import { useEffect, useState, type CSSProperties } from "react";
import { teamDisplayName, type ActivityView, type HostView, type HouseDirection } from "../../../shared/types";
import { teamStyle } from "../ui";
import type { Run } from "./Scoring";

export function HousePad({ activity: a, view, run }: { activity: ActivityView; view: HostView; run: Run }) {
  const h = a.house;
  const secret = view.house[a.id];
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<HouseDirection>(h?.direction ?? "high");
  const [teamPoints, setTeamPoints] = useState(String(h?.teamPoints ?? 5));
  const [housePoints, setHousePoints] = useState(String(h?.housePoints ?? 5));
  const [houseScore, setHouseScore] = useState("");
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (h) {
      setDirection(h.direction);
      setTeamPoints(String(h.teamPoints));
      setHousePoints(String(h.housePoints));
    }
  }, [h]);

  const live = a.format === "live";
  const drawn = view.draw.phase === "complete";
  const save = (enabled: boolean) =>
    run("house.settings", { activityId: a.id, enabled, direction, teamPoints: Number(teamPoints) || 0, housePoints: Number(housePoints) || 0 }, enabled ? "Saved" : "No longer against the House");

  if (!h && !open) {
    return (
      <button className="btn btn--small btn--ghost house-toggle" onClick={() => setOpen(true)}>
        🏠 Play this against the House
      </button>
    );
  }

  return (
    <div className="house-pad">
      <div className="row">
        <h4 className="callout__title">🏠 Beat the House</h4>
        {h ? (
          <button className="btn btn--small btn--ghost" disabled={h.settled} onClick={() => confirm("Stop playing this against the House?") && save(false)}>
            Turn off
          </button>
        ) : (
          <button className="btn btn--small btn--ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>
      <div className="inline-form__row">
        <div className="field">
          <span className="field__label">Who wins</span>
          <div className="segmented" role="radiogroup">
            {(["high", "low"] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                className={direction === d ? "is-selected" : ""}
                disabled={!!h?.locked && h.direction !== d}
                onClick={() => setDirection(d)}
              >
                {d === "high" ? "Highest score" : "Lowest score"}
              </button>
            ))}
          </div>
        </div>
        <label className="field field--inline">
          <span className="field__label">Points per team that beats it</span>
          <input className="input input--small input--num" type="number" min={0} value={teamPoints} onChange={(e) => setTeamPoints(e.target.value)} />
        </label>
        <label className="field field--inline">
          <span className="field__label">Points the House takes if nobody does</span>
          <input className="input input--small input--num" type="number" min={0} value={housePoints} onChange={(e) => setHousePoints(e.target.value)} />
        </label>
        <button className="btn btn--small btn--secondary" onClick={() => save(true)}>
          {h ? "Save" : "Play against the House"}
        </button>
      </div>
      {h && (
        <>
          <p className="host__muted">The House wins ties. Teams that don't beat it get nothing.</p>
          {secret?.houseScore === null || secret === undefined ? (
            <form
              className="inline-form__row"
              onSubmit={(e) => {
                e.preventDefault();
                if (confirm(`Lock in ${houseScore} as the House's score? It can't be changed afterwards.`)) {
                  run("house.score", { activityId: a.id, score: houseScore }, "The House's score is locked in").then((ok) => ok && setHouseScore(""));
                }
              }}
            >
              <label className="field field--inline">
                <span className="field__label">The House's score (set before the round; hidden until the face-off)</span>
                <input className="input input--small input--num" type="password" inputMode="decimal" value={houseScore} onChange={(e) => setHouseScore(e.target.value)} autoComplete="off" />
              </label>
              <button className="btn btn--small btn--primary" disabled={!houseScore.trim()}>
                🔒 Lock it in
              </button>
            </form>
          ) : (
            <p className="house-pad__locked">
              🔒 The House's score is locked in:{" "}
              <button className="btn btn--small btn--ghost" onClick={() => setPeek(!peek)}>
                {peek ? secret.houseScore : "Peek"}
              </button>
            </p>
          )}
          {live && drawn && (
            <div className="house-pad__teams">
              {view.teams.map((t) => (
                <TeamScore key={t.id} value={secret?.teamScores[t.id]} label={`${t.badge} ${teamDisplayName(t)}`} style={teamStyle(t)} onSave={(score) => run("house.teamScore", { activityId: a.id, teamId: t.id, score })} />
              ))}
            </div>
          )}
          {!live && <p className="host__muted">Each team's score is the points they earn in this {a.format === "poll" ? "poll" : "quiz"}.</p>}
          <button
            className="btn btn--primary house-pad__go"
            disabled={!drawn || !h.locked}
            onClick={() => (!h.settled || confirm("Settle it again? The old House points are voided and worked out afresh.")) && run("house.reveal", { activityId: a.id })}
          >
            {h.settled ? "Show the face-off again" : "Face off against the House on the TV"}
          </button>
        </>
      )}
    </div>
  );
}

function TeamScore({ value, label, style, onSave }: { value: number | undefined; label: string; style: CSSProperties; onSave: (v: string) => void }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  return (
    <label className="house-pad__team" style={style}>
      <span className="team-tag">{label}</span>
      <input
        className="input input--small input--num"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== (value === undefined ? "" : String(value)) && onSave(text)}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        placeholder="Score"
      />
    </label>
  );
}
