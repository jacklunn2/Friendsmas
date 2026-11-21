// Control room: secret missions (Block 4). The host writes the list, hands
// missions out, and marks each one Completed (+5, hidden until the next
// leaderboard reveal) or Noticed (fails it, voiding any +5).

import { useState, type FormEvent } from "react";
import { MAX_MISSIONS, MISSION_MAX, MISSION_POINTS, type HostView, type MissionStatus } from "../../../shared/types";
import { Avatar } from "../ui";
import type { Run } from "./Scoring";

const STATUS_LABEL: Record<MissionStatus, string> = { active: "In progress", completed: `Completed (+${MISSION_POINTS})`, noticed: "Noticed" };

export function MissionsPanel({ view, run }: { view: HostView; run: Run }) {
  const m = view.missions;
  const players = new Map(view.roster.map((p) => [p.id, p]));
  const byPlayer = new Map(m.assignments.map((a) => [a.playerId, a]));
  const here = view.roster.filter((p) => p.status === "joined");
  const without = here.filter((p) => !byPlayer.has(p.id));
  const held = new Set(m.assignments.map((a) => a.missionId));
  const free = m.list.filter((x) => !held.has(x.id));
  const drawn = view.draw.phase === "complete";
  const [showText, setShowText] = useState(false);

  return (
    <section className="panel" aria-labelledby="missions-h">
      <header className="panel__head">
        <h2 id="missions-h" className="panel__title">
          Secret missions
        </h2>
        <span className="panel__meta">
          {m.assignments.length} handed out · {free.length} unused
        </span>
      </header>
      <p className="host__muted">
        Each guest gets a different mission on their phone. Completed adds +{MISSION_POINTS} to their team, kept secret until the next leaderboard
        reveal. Noticed fails the mission and voids the +{MISSION_POINTS}.
      </p>

      <div className="row">
        <label className="switch">
          <input type="checkbox" checked={m.autoOnJoin} onChange={(e) => run("missions.auto", { on: e.target.checked })} />
          <span>Hand out a mission as each guest joins</span>
        </label>
        <button
          className="btn btn--small btn--primary"
          disabled={!without.length}
          onClick={async () => {
            const r = await run<{ given: number; short: number }>("missions.handOut", {});
            if (r && typeof r === "object" && r.short) alert(`Handed out ${r.given}. ${r.short} guests still need a mission: add more to the list.`);
          }}
        >
          Hand out missions{without.length ? ` (${without.length})` : ""}
        </button>
      </div>
      {without.length > free.length && (
        <p className="callout callout--warn">
          {without.length} guests are waiting for a mission but only {free.length} are unused. Add {without.length - free.length} more.
        </p>
      )}

      {m.assignments.length > 0 && (
        <>
          <div className="row">
            <h3 className="callout__title">Who has what</h3>
            <button className="btn btn--small btn--ghost" aria-pressed={showText} onClick={() => setShowText(!showText)}>
              {showText ? "Hide the missions" : "Show the missions"}
            </button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Guest</th>
                <th>Mission</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {m.assignments.map((a) => {
                const p = players.get(a.playerId);
                if (!p) return null;
                return (
                  <tr key={a.playerId}>
                    <td>
                      <span className="data-table__who">
                        <Avatar player={p} /> {p.name}
                      </span>
                    </td>
                    <td>
                      {showText ? a.text : <span className="host__muted">Hidden</span>}
                      {!a.seen && <div className="host__muted">Not opened yet</div>}
                    </td>
                    <td>
                      <span className={`tag mission-tag mission-tag--${a.status}`}>{STATUS_LABEL[a.status]}</span>
                    </td>
                    <td>
                      <span className="row__actions">
                        {a.status !== "completed" && (
                          <button
                            className="btn btn--small btn--secondary"
                            disabled={!drawn}
                            title={drawn ? undefined : "Missions score once the teams are drawn"}
                            onClick={() => run("missions.complete", { playerId: a.playerId }, `+${MISSION_POINTS} for ${p.name}'s team, hidden until the next reveal`)}
                          >
                            Completed
                          </button>
                        )}
                        {a.status !== "noticed" && (
                          <button className="btn btn--small btn--ghost" onClick={() => run("missions.notice", { playerId: a.playerId }, `${p.name}'s mission failed`)}>
                            Noticed
                          </button>
                        )}
                        {a.status !== "active" && (
                          <button className="btn btn--small btn--ghost" onClick={() => run("missions.reset", { playerId: a.playerId })}>
                            Undo
                          </button>
                        )}
                        <details className="menu">
                          <summary className="btn btn--small btn--ghost" aria-label={`More for ${p.name}`}>
                            ⋯
                          </summary>
                          <div className="menu__list">
                            <button
                              className="menu__item"
                              disabled={!free.length}
                              onClick={() => confirm(`Give ${p.name} a new random mission?`) && run("missions.redraw", { playerId: a.playerId })}
                            >
                              Redraw at random
                            </button>
                            {free.map((x) => (
                              <button
                                key={x.id}
                                className="menu__item"
                                onClick={() => confirm(`Give ${p.name} this mission instead?\n\n${x.text}`) && run("missions.assign", { playerId: a.playerId, missionId: x.id })}
                              >
                                Give: {x.text.length > 50 ? `${x.text.slice(0, 49)}…` : x.text}
                              </button>
                            ))}
                            <button
                              className="menu__item"
                              onClick={() => confirm(`Take back ${p.name}'s mission?`) && run("missions.remove", { playerId: a.playerId })}
                            >
                              Take it back
                            </button>
                          </div>
                        </details>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {drawn && (
            <button
              className="btn btn--small btn--ghost btn--finale"
              disabled={view.stage.screen === "missions"}
              onClick={() => confirm("Reveal every secret mission on the TV?") && run("stage.show", { screen: "missions" })}
            >
              {view.stage.screen === "missions" ? "Missions are on the TV" : "Finale: reveal every mission on the TV"}
            </button>
          )}
        </>
      )}

      <MissionList view={view} run={run} />
    </section>
  );
}

function MissionList({ view, run }: { view: HostView; run: Run }) {
  const m = view.missions;
  const held = new Set(m.assignments.map((a) => a.missionId));
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await run("missions.add", { text })) setText("");
  };

  return (
    <details className="history">
      <summary className="history__summary">The missions list ({m.list.length})</summary>
      <ul className="plain-list mission-list">
        {m.list.map((x) => (
          <li key={x.id} className="mission-list__row">
            {editing?.id === x.id ? (
              <form
                className="mission-list__edit"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run("missions.update", { id: x.id, text: editing.text })) setEditing(null);
                }}
              >
                <input className="input input--small" value={editing.text} maxLength={MISSION_MAX} onChange={(e) => setEditing({ ...editing, text: e.target.value })} autoFocus />
                <button className="btn btn--small btn--primary">Save</button>
                <button type="button" className="btn btn--small btn--ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span>
                  {x.text} {held.has(x.id) && <span className="tag">handed out</span>}
                </span>
                <span className="row__actions">
                  <button className="btn btn--small btn--ghost" onClick={() => setEditing({ id: x.id, text: x.text })}>
                    Edit
                  </button>
                  <button
                    className="btn btn--small btn--ghost"
                    disabled={held.has(x.id)}
                    title={held.has(x.id) ? "Someone has this mission" : undefined}
                    onClick={() => confirm("Delete this mission?") && run("missions.delete", { id: x.id })}
                  >
                    Delete
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <form className="mission-list__edit" onSubmit={add}>
        <input
          className="input input--small"
          placeholder="Write a new mission"
          value={text}
          maxLength={MISSION_MAX}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn--small btn--secondary" disabled={!text.trim() || m.list.length >= MAX_MISSIONS}>
          Add
        </button>
      </form>
    </details>
  );
}
