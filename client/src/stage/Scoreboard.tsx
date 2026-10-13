// The TV's scoring screens: an activity's intro and timer, its results, the
// leaderboard (revealed from last place up) and the final results.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ordinal,
  placeLabel,
  signed,
  teamDisplayName,
  type PublicPlayer,
  type PublicTeam,
  type StageView,
  type StandingsRow,
} from "../../../shared/types";
import { audioOn, sfx } from "../audio";
import { useTicker } from "../net";
import { rowDelays, WINNER_DELAY_MS } from "../timing";
import { Avatar, formatClock, playerMap, teamStyle } from "../ui";

/** Reveals already shown on this TV, so switching screens doesn't replay them. */
const seenReveals = new Set<string>();

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---------------------------------------------------------------------------
// Activity intro

export function ActivityIntro({ view, serverNow }: { view: StageView; serverNow: () => number }) {
  const a = view.activities.find((x) => x.id === view.stage.activityId);
  const timer = view.stage.timer;
  const running = !!timer?.endsAt;
  const now = useTicker(200, running);
  const left = timer ? (timer.endsAt ? timer.endsAt - serverNow() : (timer.remainingMs ?? timer.durationMs)) : 0;
  const done = !!timer && left <= 0;

  // Pips for the last ten seconds, then the buzzer.
  const lastSecond = useRef<number | null>(null);
  useEffect(() => {
    if (!running || !audioOn()) return;
    const sec = Math.ceil(left / 1000);
    if (sec === lastSecond.current) return;
    lastSecond.current = sec;
    if (sec <= 0) sfx.buzzer();
    else if (sec <= 10) sfx.pip();
  }, [now, running, left]);

  if (!a) return null;
  return (
    <section className="scene activity-intro">
      <p className="activity-intro__kind">{a.kind === "team" ? "Team challenge" : "Every player for their team"}</p>
      <h1 className="activity-intro__name">{a.name}</h1>
      {!timer && <p className="activity-intro__hint">📱 Instructions are on your phones</p>}
      {timer && (
        <p className={`activity-intro__timer${done ? " is-done" : left <= 10_000 && running ? " is-low" : ""}`} aria-live="off">
          {done ? "Time's up!" : formatClock(left)}
        </p>
      )}
      {timer && <p className="activity-intro__hint">📱 Instructions are on your phones</p>}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Activity results

export function ActivityResults({ view }: { view: StageView }) {
  const players = useMemo(() => playerMap(view.players), [view.players]);
  const teams = useMemo(() => new Map(view.teams.map((t) => [t.id, t])), [view.teams]);
  const res = view.results;
  const a = view.activities.find((x) => x.id === res?.activityId);
  const key = `results:${res?.activityId}:${res?.rows.map((r) => r.points).join(",")}`;
  const animate = useFirstShowing(key);
  if (!res || !a) return null;
  const delays = rowDelays(res.rows.length, false).map((d) => d * 0.6);

  return (
    <section className="scene board">
      <header className="board__head">
        <p className="board__kicker">Results</p>
        <h1 className="board__title">{a.name}</h1>
      </header>
      <ol className="board__rows">
        {res.rows.map((r, i) => {
          const team = teams.get(r.teamId);
          if (!team) return null;
          return (
            <li key={r.teamId} className={`board-row${animate ? " is-animated" : ""}`} style={rowStyle(team, delays[i])}>
              <span className="board-row__place">{r.points > 0 ? ordinal(r.rank) : "–"}</span>
              <TeamName team={team} players={players} />
              <span className="board-row__earners">
                {a.kind === "individual" &&
                  r.earners.map((e) => {
                    const p = players.get(e.playerId);
                    return p ? (
                      <span key={e.playerId} className="earner-badge">
                        <Avatar player={p} /> {signed(e.points)}
                      </span>
                    ) : null;
                  })}
              </span>
              <span className="board-row__points">{signed(r.points)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The leaderboard

export function Standings({ view }: { view: StageView }) {
  const players = useMemo(() => playerMap(view.players), [view.players]);
  const teams = useMemo(() => new Map(view.teams.map((t) => [t.id, t])), [view.teams]);
  const st = view.standings;
  const final = !!st?.final && view.stage.screen === "final";
  const animate = useFirstShowing(`standings:${st?.seq}:${final}`);
  const rows = st?.rows ?? [];
  const delays = useMemo(() => (animate ? rowDelays(rows.length, final) : rows.map(() => 0)), [animate, rows.length, final]);
  const winners = rows.filter((r) => r.rank === 1);
  const [showWinner, setShowWinner] = useState(!animate && final);

  // Sound and the winner moment, timed to the rows.
  useEffect(() => {
    if (!animate || !rows.length) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const leaderAt = delays[0];
    rows.forEach((_, i) => {
      if (i === 0) return;
      timers.push(setTimeout(() => audioOn() && sfx.thud(), delays[i]));
    });
    if (rows.length > 1 && final) {
      timers.push(setTimeout(() => audioOn() && sfx.drumroll((leaderAt - delays[1]) / 1000 - 0.3), delays[1] + 300));
    }
    timers.push(setTimeout(() => audioOn() && (final ? sfx.finale() : sfx.fanfare()), leaderAt));
    if (final) timers.push(setTimeout(() => setShowWinner(true), leaderAt + WINNER_DELAY_MS));
    return () => timers.forEach(clearTimeout);
    // Runs once per reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, st?.seq]);

  if (!st) return null;

  return (
    <section className={`scene board${final ? " board--final" : ""}`}>
      <header className="board__head">
        <p className="board__kicker">{final ? "Friendsmas" : view.blackout ? "Frozen until the finale" : "Standings"}</p>
        <h1 className="board__title">{final ? "Final results" : "The leaderboard"}</h1>
      </header>
      <ol className="board__rows">
        {rows.map((r, i) => {
          const team = teams.get(r.teamId);
          if (!team) return null;
          return (
            <StandingsLine key={r.teamId} row={r} team={team} players={players} delay={delays[i]} animate={animate} leader={i === 0} />
          );
        })}
      </ol>
      {final && showWinner && <Winners rows={winners} teams={teams} players={players} />}
    </section>
  );
}

function StandingsLine({
  row,
  team,
  players,
  delay,
  animate,
  leader,
}: {
  row: StandingsRow;
  team: PublicTeam;
  players: Map<string, PublicPlayer>;
  delay: number;
  animate: boolean;
  leader: boolean;
}) {
  const from = animate ? (row.prevPoints ?? 0) : row.points;
  const points = useCountUp(from, row.points, delay + 250, 900);
  const gained = row.prevPoints === null ? null : row.points - row.prevPoints;
  const moved = row.prevRank === null ? 0 : row.prevRank - row.rank;
  return (
    <li className={`board-row${animate ? " is-animated" : ""}${leader && row.rank === 1 ? " board-row--leader" : ""}`} style={rowStyle(team, delay)}>
      <span className="board-row__place">{placeLabel(row)}</span>
      <TeamName team={team} players={players} />
      <span className="board-row__move">
        {gained !== null && gained !== 0 && <span className="board-row__gained">{signed(gained)}</span>}
        {moved !== 0 && (
          <span className={`board-row__arrow ${moved > 0 ? "is-up" : "is-down"}`} aria-label={moved > 0 ? `Up ${moved}` : `Down ${-moved}`}>
            {moved > 0 ? "▲" : "▼"} {Math.abs(moved)}
          </span>
        )}
      </span>
      <span className="board-row__points">{points}</span>
    </li>
  );
}

function TeamName({ team, players }: { team: PublicTeam; players: Map<string, PublicPlayer> }) {
  return (
    <span className="board-row__team">
      <span className="board-row__badge" aria-hidden>
        {team.badge}
      </span>
      <span className="board-row__name">{teamDisplayName(team)}</span>
      <span className="board-row__members">
        {team.memberIds.map((id) => {
          const p = players.get(id);
          return p ? <Avatar key={id} player={p} className="board-row__avatar" /> : null;
        })}
      </span>
    </span>
  );
}

function Winners({ rows, teams, players }: { rows: StandingsRow[]; teams: Map<string, PublicTeam>; players: Map<string, PublicPlayer> }) {
  const winners = rows.map((r) => teams.get(r.teamId)).filter((t): t is PublicTeam => !!t);
  const tie = winners.length > 1;
  return (
    <div className="winner" role="status">
      <Confetti colours={winners.map((t) => t.colour)} />
      <div className="winner__card">
        <p className="winner__kicker">{tie ? "It's a tie for first!" : "The winners of Friendsmas"}</p>
        {winners.map((t) => (
          <div key={t.id} className="winner__team" style={teamStyle(t)}>
            <div className="winner__photos">
              {t.memberIds.map((id) => {
                const p = players.get(id);
                return p ? <Avatar key={id} player={p} className="winner__photo" /> : null;
              })}
            </div>
            <h2 className="winner__name">
              {t.badge} {teamDisplayName(t)}
            </h2>
            <p className="winner__members">{t.memberIds.map((id) => players.get(id)?.name).filter(Boolean).join(" & ")}</p>
          </div>
        ))}
        {tie && <p className="winner__hint">Time for a sudden-death tie-breaker.</p>}
      </div>
    </div>
  );
}

function Confetti({ colours }: { colours: string[] }) {
  const pieces = useMemo(() => {
    const palette = [...colours, "#f2b544", "#eef4f1", "#e2445c", "#5fd6a0"];
    return Array.from({ length: prefersReducedMotion() ? 0 : 140 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 2.5,
      duration: 3.2 + Math.random() * 2.6,
      colour: palette[i % palette.length],
      size: 0.5 + Math.random() * 0.7,
      drift: (Math.random() - 0.5) * 18,
      round: Math.random() < 0.3,
    }));
  }, [colours]);
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((p) => (
        <span
          key={p.id}
          className={`confetti__piece${p.round ? " is-round" : ""}`}
          style={
            {
              left: `${p.left}%`,
              background: p.colour,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              "--size": `${p.size}vw`,
              "--drift": `${p.drift}vw`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers

function rowStyle(team: PublicTeam, delay: number): CSSProperties {
  return { ...teamStyle(team), animationDelay: `${delay}ms` } as CSSProperties;
}

/** True only the first time this TV shows a given reveal. */
function useFirstShowing(key: string): boolean {
  const [first] = useState(() => {
    if (prefersReducedMotion()) return false;
    const isNew = !seenReveals.has(key);
    seenReveals.add(key);
    return isNew;
  });
  return first;
}

/** Counts from `from` to `to`, starting after `delay`. */
function useCountUp(from: number, to: number, delay: number, duration: number): number {
  const [value, setValue] = useState(from);
  useEffect(() => {
    if (from === to) {
      setValue(to);
      return;
    }
    let raf = 0;
    const start = performance.now() + delay;
    const frame = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      setValue(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [from, to, delay, duration]);
  return value;
}
