import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  EXTRA_BADGES,
  MOTTO_MAX,
  TEAM_BADGES,
  TEAM_COLOURS,
  teamDisplayName,
  type HostPlayer,
  type HostView,
  type PublicTeam,
} from "../../../shared/types";
import { useTicker, type ConnStatus } from "../net";
import { Avatar, ConnectionBanner, EventCodeContext, formatClock, teamStyle, Wordmark } from "../ui";
import { ScoringPanel, type Notify, type Run } from "./Scoring";

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

interface Toast {
  kind: "ok" | "error";
  text: string;
  id: number;
  action?: { label: string; onClick: () => void };
  ms?: number;
}

interface Props {
  view: HostView;
  status: ConnStatus;
  send: Send;
  serverNow: () => number;
}

export function ControlRoom({ view, status, send, serverNow }: Props) {
  const [toast, setToast] = useState<Toast | null>(null);
  const notify: Notify = useCallback((t) => setToast({ ...t, id: Date.now() }), []);

  const run: Run = useCallback(
    async (action, payload, okText) => {
      try {
        const data = await send(action, payload);
        if (okText) setToast({ kind: "ok", text: okText, id: Date.now() });
        // Success always returns something, so callers can tell it worked.
        return (data ?? true) as never;
      } catch (e) {
        setToast({ kind: "error", text: (e as Error).message, id: Date.now() });
        return undefined;
      }
    },
    [send],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms ?? (toast.kind === "error" ? 6000 : 3000));
    return () => clearTimeout(t);
  }, [toast]);

  const drafting = view.draw.phase === "draft";

  return (
    <EventCodeContext.Provider value={view.eventCode}>
    <main className="host">
      <ConnectionBanner status={status} />
      <TopBar view={view} run={run} status={status} />
      <NowPanel view={view} run={run} serverNow={serverNow} />
      {!drafting && view.draw.phase === "complete" && (
        <ScoringPanel view={view} run={run} notify={notify} serverNow={serverNow} />
      )}
      <div className="host__grid">
        <GuestsPanel view={view} run={run} />
        {drafting ? <DrawSetup view={view} run={run} /> : <TeamsPanel view={view} run={run} />}
      </div>
      {drafting && <ScoringPanel view={view} run={run} notify={notify} serverNow={serverNow} />}
      <footer className="host__footer">
        <ActivityLog view={view} />
        <StartFresh run={run} />
      </footer>
      {toast && (
        <div key={toast.id} className={`toast toast--${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="toast__action"
              onClick={() => {
                toast.action!.onClick();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </main>
    </EventCodeContext.Provider>
  );
}

// ---------------------------------------------------------------------------

function TopBar({ view, run, status }: { view: HostView; run: Run; status: ConnStatus }) {
  const joinUrl = `${location.origin}/e/${view.eventCode}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy the guest link:", joinUrl);
    }
  };
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <Wordmark className="wordmark--host" />
        <span className="topbar__title">Control room</span>
        <span className={`pill pill--${status === "open" ? "ok" : "warn"}`}>{status === "open" ? "Live" : "Reconnecting"}</span>
      </div>
      <div className="topbar__actions">
        <button className="btn btn--secondary" onClick={copy}>
          {copied ? "Guest link copied" : "Copy guest link"}
        </button>
        <button
          className="btn btn--secondary"
          onClick={() => window.open(`/stage?c=${view.eventCode}`, "friendsmas-stage", "popup,width=1280,height=720")}
        >
          Launch stage
        </button>
        <button
          className={`btn ${view.intermission ? "btn--warn" : "btn--secondary"}`}
          aria-pressed={view.intermission}
          onClick={() => run("stage.intermission", { on: !view.intermission })}
        >
          {view.intermission ? "End intermission" : "Intermission"}
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// The one big next action

function drawShape(n: number, fallback: HostView["draw"]["oddFallback"]): string | null {
  if (n < 2) return null;
  if (n % 2 === 0) return `${n / 2} pairs`;
  if (fallback === "trio") return n >= 3 ? `${(n - 3) / 2} pairs and a team of three` : null;
  if (fallback === "solo") return `${(n - 1) / 2} pairs and one solo player`;
  return null;
}

function NowPanel({ view, run, serverNow }: { view: HostView; run: Run; serverNow: () => number }) {
  const [busy, setBusy] = useState(false);
  const { draw, naming, roster } = view;
  const cooling = view.spinCooldownUntil !== null && view.spinCooldownUntil > serverNow();
  const namingOpen = naming.phase === "open";
  useTicker(250, cooling || namingOpen || view.quiz?.phase === "open");

  const act = async (action: string, payload?: Record<string, unknown>) => {
    setBusy(true);
    await run(action, payload);
    setBusy(false);
  };

  let label = "";
  let hint: ReactNode = "";
  let onClick: (() => void) | null = null;
  let secondary: ReactNode = null;

  const eligible = roster.filter((p) => p.status === "joined");
  const notJoined = roster.filter((p) => p.status === "expected");

  if (draw.phase === "draft") {
    const shape = drawShape(eligible.length, draw.oddFallback);
    label = shape ? `Lock the draw: ${shape}` : "Lock the draw";
    if (eligible.length < 2) hint = "At least two guests need to join first.";
    else if (!shape) hint = `${eligible.length} guests is an odd number. Choose how to handle it under Team draw.`;
    else {
      hint = notJoined.length
        ? `${notJoined.length} on the guest list ${notJoined.length === 1 ? "hasn't" : "haven't"} joined yet and will miss the draw. Wait for them, or exclude them.`
        : "Everyone on the guest list is here. Locking saves the teams; the wheel then reveals them.";
      onClick = () => act("draw.lock");
    }
  } else if (draw.phase === "locked" || draw.phase === "revealing") {
    label = draw.nextIsFinal ? "Reveal the final team" : "Spin the wheel";
    hint = cooling ? "The wheel is turning…" : `Reveal ${draw.step + 1} of ${draw.totalSteps}`;
    onClick = cooling ? null : () => act("draw.spin", { expectedStep: draw.step });
    secondary = (
      <button
        className="btn btn--ghost"
        onClick={() => {
          if (confirm("Skip the rest of the reveal and show all teams now?")) act("draw.skip");
        }}
      >
        Skip to results
      </button>
    );
  } else if (naming.phase === "idle") {
    label = "Open team naming (2 minutes)";
    hint = "Each team picks a name on their phones. Unchosen teams get their first suggestion.";
    onClick = () => act("naming.start");
  } else if (namingOpen) {
    const named = view.teams.filter((t) => t.name).length;
    label = "Close team naming now";
    hint = `${formatClock((naming.deadline ?? 0) - serverNow())} left · ${named} of ${view.teams.length} teams named`;
    onClick = () => act("naming.close");
  } else if (view.stage.screen === "quiz" && view.quiz && !view.intermission) {
    const qz = view.quiz;
    const quizName = view.activities.find((a) => a.id === qz.activityId)?.name ?? "The quiz";
    const total = qz.kind === "team" ? view.teams.length : view.teams.reduce((n, t) => n + t.memberIds.length, 0);
    if (qz.phase === "intro") {
      label = "Open question 1";
      hint = `${quizName} is on the TV. Open the first question when everyone's ready.`;
      onClick = () => act("quiz.open");
    } else if (qz.phase === "open") {
      const left = qz.endsAt ? ` · ${formatClock(qz.endsAt - serverNow())} left` : "";
      label = "Close answers";
      hint = `Question ${qz.index + 1} of ${qz.total}: ${view.quizAnswers.length} of ${total} answered${left}`;
      onClick = () => act("quiz.close");
    } else if (qz.phase === "closed") {
      const toCheck = view.quizAnswers.filter((x) => x.auto === "close" && x.override === null).length;
      label = "Reveal the answer";
      hint = toCheck
        ? `${toCheck} typed ${toCheck === 1 ? "answer is" : "answers are"} close. Check ${toCheck === 1 ? "it" : "them"} under Scoring first, or after the reveal.`
        : `Question ${qz.index + 1} of ${qz.total}: answers are in.`;
      onClick = () => act("quiz.reveal");
    } else if (qz.index + 1 < qz.total) {
      label = `Open question ${qz.index + 2}`;
      hint = `${qz.total - qz.index - 1} ${qz.total - qz.index - 1 === 1 ? "question" : "questions"} to go in ${quizName}.`;
      onClick = () => act("quiz.open");
    } else {
      label = "Show the round results";
      hint = `That was the last question in ${quizName}. Points stay hidden until now.`;
      onClick = () => act("results.show", { activityId: qz.activityId });
    }
  } else {
    const anyPoints = view.ledger.some((e) => !e.voided);
    const onBoard = view.stage.screen === "standings" || view.stage.screen === "final";
    if (view.blackout) {
      label = "Reveal the final results";
      hint = "The blackout is on, so the leaderboard is frozen. The final reveal shows every point from last place up, then the winners.";
      onClick = anyPoints
        ? () => {
            if (confirm("Reveal the final results now?")) act("standings.final");
          }
        : null;
    } else if (view.standingsStale && anyPoints) {
      const changed = view.teams.filter((t) => (view.liveTotals[t.id] ?? 0) !== (view.standings?.rows.find((r) => r.teamId === t.id)?.points ?? 0)).length;
      label = view.standings ? "Reveal the new standings" : "Reveal the first standings";
      hint = `${changed} ${changed === 1 ? "team's score has" : "teams' scores have"} changed since the leaderboard was last shown. The TV reveals it from last place up.`;
      onClick = () => act("standings.reveal");
    } else if (view.standings && !onBoard) {
      label = "Show the leaderboard";
      hint = "The leaderboard is up to date.";
      onClick = () => act("stage.show", { screen: "standings" });
    } else if (!anyPoints) {
      label = "Waiting for points";
      hint = view.activities.length
        ? "Choose an activity under Scoring, show it on the TV, then award points."
        : "Add your first activity under Scoring, then award points as you play.";
    } else {
      label = view.standings?.final ? "Final results are on the TV" : "Leaderboard is up to date";
      hint = view.standings?.final
        ? "Award a tie-breaker and reveal the final results again if you need to."
        : "Award more points, and the next reveal button appears here.";
    }
  }

  return (
    <section className="now" aria-label="Next action">
      <div className="now__text">
        <h1 className="now__label">Next up</h1>
        <p className="now__hint">{hint}</p>
      </div>
      <div className="now__actions">
        {secondary}
        <button className="btn btn--primary btn--huge" disabled={!onClick || busy} onClick={onClick ?? undefined}>
          {label}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Guests

const STATUS_TEXT: Record<HostPlayer["status"], string> = {
  joined: "Here",
  expected: "Not joined yet",
  pending: "Waiting for approval",
  excluded: "Excluded",
  left: "Gone home",
};

function GuestsPanel({ view, run }: { view: HostView; run: Run }) {
  const [names, setNames] = useState("");
  const drafting = view.draw.phase === "draft";
  const pending = view.roster.filter((p) => p.status === "pending");
  const listed = view.roster.filter((p) => p.status !== "pending");
  const here = listed.filter((p) => p.status === "joined").length;
  const teams = useMemo(() => new Map(view.teams.map((t) => [t.id, t])), [view.teams]);
  const tests = listed.some((p) => p.isTest);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const data = await run<{ added: number }>("guest.add", { names });
    if (data) setNames("");
  };

  return (
    <section className="panel" aria-labelledby="guests-h">
      <header className="panel__head">
        <h2 id="guests-h" className="panel__title">
          Guests
        </h2>
        <span className="panel__meta">
          {here} here of {listed.length}
        </span>
      </header>

      {pending.length > 0 && (
        <div className="callout">
          <h3 className="callout__title">Asking to join</h3>
          <ul className="plain-list">
            {pending.map((p) => (
              <li key={p.id} className="row">
                <span className="row__name">
                  <Avatar player={p} /> {p.name}
                </span>
                <span className="row__actions">
                  <button className="btn btn--small btn--primary" onClick={() => run("guest.approve", { id: p.id })}>
                    Let in
                  </button>
                  <button className="btn btn--small btn--ghost" onClick={() => run("guest.reject", { id: p.id })}>
                    Turn away
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="roster">
        {listed.map((p) => (
          <RosterRow key={p.id} player={p} team={p.teamId ? teams.get(p.teamId) : undefined} run={run} />
        ))}
        {listed.length === 0 && <li className="roster__empty">Add your guest list below. Guests then tap their name on their phones.</li>}
      </ul>

      <form className="add-guests" onSubmit={add}>
        <label className="field">
          <span className="field__label">Add guests, one per line</span>
          <textarea className="input input--area" rows={3} value={names} onChange={(e) => setNames(e.target.value)} />
        </label>
        <button className="btn btn--secondary" disabled={!names.trim()}>
          Add to guest list
        </button>
      </form>

      {drafting && (
        <div className="test-guests">
          <span className="host__muted">Rehearsing?</span>
          <button className="btn btn--small btn--ghost" onClick={() => run("guest.addTest", { count: 6 }, "Added 6 test guests")}>
            Add 6 test guests
          </button>
          {tests && (
            <button className="btn btn--small btn--ghost" onClick={() => run("guest.removeTests", {}, "Removed test guests")}>
              Remove test guests
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function RosterRow({ player: p, team, run }: { player: HostPlayer; team?: PublicTeam; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => menu.current?.removeAttribute("open");

  if (editing) {
    return (
      <li className="roster__row">
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await run("guest.rename", { id: p.id, name });
            setEditing(false);
          }}
        >
          <input className="input input--small" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Guest name" />
          <button className="btn btn--small btn--primary">Save</button>
          <button type="button" className="btn btn--small btn--ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      </li>
    );
  }

  const actions: { label: string; onClick: () => void }[] = [{ label: "Rename", onClick: () => setEditing(true) }];
  if ((p.status === "joined" || p.status === "expected") && !p.teamId) {
    actions.push({ label: "Exclude from the draw", onClick: () => run("guest.exclude", { id: p.id }) });
  }
  if (p.status === "excluded" || p.status === "left") actions.push({ label: "Include again", onClick: () => run("guest.include", { id: p.id }) });
  if (p.teamId && p.status === "joined") actions.push({ label: "Mark as gone home", onClick: () => run("guest.leave", { id: p.id }) });
  if (!p.isTest) actions.push({ label: "Make a rejoin code", onClick: () => run("guest.rejoinCode", { id: p.id }) });
  if (p.photo) {
    actions.push({
      label: "Remove their photo",
      onClick: () => {
        if (confirm(`Remove ${p.name}'s photo? They can add a new one from their phone.`)) run("guest.removePhoto", { id: p.id });
      },
    });
  }
  if (p.hasDevice) {
    actions.push({
      label: "Unlink their phone",
      onClick: () => {
        if (confirm(`Unlink ${p.name}'s phone? They'll need to join again.`)) run("guest.release", { id: p.id });
      },
    });
  }
  if (!p.teamId) {
    actions.push({
      label: "Remove from the list",
      onClick: () => {
        if (confirm(`Remove ${p.name} from the guest list?`)) run("guest.remove", { id: p.id });
      },
    });
  }

  return (
    <li className={`roster__row roster__row--${p.status}`}>
      <span className="row__name">
        {p.status === "expected" ? <span aria-hidden>·</span> : <Avatar player={p} />} {p.name}
        {p.isTest && <span className="tag">test</span>}
      </span>
      <span className="row__status">
        {team ? (
          <span className="team-tag" style={teamStyle(team)}>
            {team.badge} {teamDisplayName(team)}
          </span>
        ) : (
          STATUS_TEXT[p.status]
        )}
        {p.rejoinCode && <span className="rejoin">Rejoin code {p.rejoinCode}</span>}
      </span>
      <details className="menu" ref={menu}>
        <summary className="btn btn--small btn--ghost" aria-label={`Actions for ${p.name}`}>
          ⋯
        </summary>
        <div className="menu__list">
          {actions.map((a) => (
            <button
              key={a.label}
              className="menu__item"
              onClick={() => {
                close();
                a.onClick();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </details>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Draw set-up (before locking)

function DrawSetup({ view, run }: { view: HostView; run: Run }) {
  const eligible = view.roster.filter((p) => p.status === "joined");
  const notJoined = view.roster.filter((p) => p.status === "expected");
  const n = eligible.length;
  const odd = n % 2 === 1;
  const shape = drawShape(n, view.draw.oddFallback);

  return (
    <section className="panel" aria-labelledby="draw-h">
      <header className="panel__head">
        <h2 id="draw-h" className="panel__title">
          Team draw
        </h2>
        <span className="panel__meta">{shape ? `${n} guests → ${shape}` : `${n} guests`}</span>
      </header>

      <fieldset className="choice" disabled={!odd}>
        <legend className="choice__legend">If there's an odd number</legend>
        {!odd && <p className="host__muted">Not needed right now: everyone gets a partner.</p>}
        <Choice
          name="odd"
          checked={view.draw.oddFallback === "trio"}
          onChange={() => run("draw.options", { oddFallback: "trio" })}
          title="One team of three"
          body="In head-to-head challenges, two of the three play each round."
        />
        <Choice
          name="odd"
          checked={view.draw.oddFallback === "solo"}
          onChange={() => run("draw.options", { oddFallback: "solo" })}
          title="One solo player"
          body="One guest plays alone, with team scores scaled to match a pair."
        />
      </fieldset>

      <fieldset className="choice">
        <legend className="choice__legend">How phones see the draw</legend>
        <Choice
          name="reveal"
          checked={view.draw.revealMode === "live"}
          onChange={() => run("draw.options", { revealMode: "live" })}
          title="Live"
          body="Each phone buzzes when its owner is drawn."
        />
        <Choice
          name="reveal"
          checked={view.draw.revealMode === "finale"}
          onChange={() => run("draw.options", { revealMode: "finale" })}
          title="Grand finale"
          body="Phones say “Eyes on the TV” until every team is drawn."
        />
      </fieldset>

      {notJoined.length > 0 && (
        <div className="callout callout--warn">
          <h3 className="callout__title">Not joined yet</h3>
          <p>{notJoined.map((p) => p.name).join(", ")}</p>
          <p className="host__muted">They'll miss the draw. You can wait, exclude them now, or add them to a team later.</p>
        </div>
      )}
    </section>
  );
}

function Choice({ name, checked, onChange, title, body }: { name: string; checked: boolean; onChange: () => void; title: string; body: string }) {
  return (
    <label className={`choice__option${checked ? " is-checked" : ""}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span>
        <span className="choice__title">{title}</span>
        <span className="choice__body">{body}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Teams (after locking)

function TeamsPanel({ view, run }: { view: HostView; run: Run }) {
  const complete = view.draw.phase === "complete";
  const players = useMemo(() => new Map(view.roster.map((p) => [p.id, p])), [view.roster]);
  const unassigned = view.roster.filter((p) => p.status === "joined" && !p.teamId);
  const [resetOpen, setResetOpen] = useState(false);

  return (
    <section className="panel" aria-labelledby="teams-h">
      <header className="panel__head">
        <h2 id="teams-h" className="panel__title">
          Teams
        </h2>
        <span className="panel__meta">
          {complete ? `${view.teams.length} teams` : `Revealed ${view.draw.step} of ${view.draw.totalSteps}`}
        </span>
      </header>

      {complete && unassigned.length > 0 && (
        <div className="callout callout--warn">
          <h3 className="callout__title">Not on a team</h3>
          <ul className="plain-list">
            {unassigned.map((p) => (
              <li key={p.id} className="row">
                <span className="row__name">
                  <Avatar player={p} /> {p.name}
                </span>
                <AddToTeam player={p} teams={view.teams} run={run} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="team-editors">
        {view.teams.map((t) => (
          <TeamEditor
            key={t.id}
            team={t}
            teams={view.teams}
            players={players}
            suggestions={view.suggestions[t.id] ?? []}
            complete={complete}
            run={run}
          />
        ))}
      </div>

      <div className="danger">
        {view.ledger.some((e) => !e.voided) ? (
          <span className="host__muted">Points have been awarded, so the teams are fixed. Use Start fresh at the bottom of the page to rehearse again.</span>
        ) : (
          <>
            <button className="btn btn--ghost btn--danger" onClick={() => setResetOpen(true)}>
              Reset the draw
            </button>
            <span className="host__muted">Clears all teams and names. Only possible before any points are awarded.</span>
          </>
        )}
      </div>
      {resetOpen && <ResetDialog onClose={() => setResetOpen(false)} run={run} />}
    </section>
  );
}

function AddToTeam({ player, teams, run }: { player: HostPlayer; teams: PublicTeam[]; run: Run }) {
  const [target, setTarget] = useState("random");
  return (
    <span className="row__actions">
      <select className="input input--small" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={`Team for ${player.name}`}>
        <option value="random">Spin for a team (smallest teams)</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.badge} {teamDisplayName(t)} ({t.memberCount})
          </option>
        ))}
      </select>
      <button className="btn btn--small btn--primary" onClick={() => run("team.add", { playerId: player.id, teamId: target }, `${player.name} is on a team`)}>
        Add
      </button>
    </span>
  );
}

function TeamEditor({
  team,
  teams,
  players,
  suggestions,
  complete,
  run,
}: {
  team: PublicTeam;
  teams: PublicTeam[];
  players: Map<string, HostPlayer>;
  suggestions: string[];
  complete: boolean;
  run: Run;
}) {
  const [name, setName] = useState(team.name ?? "");
  const [motto, setMotto] = useState(team.motto);
  useEffect(() => setName(team.name ?? ""), [team.name]);
  useEffect(() => setMotto(team.motto), [team.motto]);

  return (
    <article className="team-editor" style={teamStyle(team)}>
      <header className="team-editor__head">
        <span className="team-editor__badge">{team.badge}</span>
        <h3 className="team-editor__name">{teamDisplayName(team)}</h3>
        <span className="host__muted">{team.memberCount} players</span>
      </header>

      <ul className="team-editor__members">
        {team.memberIds.map((id) => {
          const p = players.get(id);
          if (!p) return null;
          return (
            <li key={id} className="row">
              <span className="row__name">
                <Avatar player={p} /> {p.name}
                {p.status === "left" && <span className="tag">gone home</span>}
              </span>
              {complete && (
                <select
                  className="input input--small"
                  value=""
                  aria-label={`Move ${p.name}`}
                  onChange={(e) => e.target.value && run("team.move", { playerId: id, teamId: e.target.value }, `${p.name} moved`)}
                >
                  <option value="">Move to…</option>
                  {teams
                    .filter((t) => t.id !== team.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.badge} {teamDisplayName(t)}
                      </option>
                    ))}
                </select>
              )}
            </li>
          );
        })}
        {team.memberIds.length < team.memberCount && (
          <li className="host__muted">{team.memberCount - team.memberIds.length} still to be revealed</li>
        )}
      </ul>

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          run("team.update", { teamId: team.id, name }, "Team name saved");
        }}
      >
        <input
          className="input input--small"
          value={name}
          placeholder={suggestions[0] ?? "Team name"}
          list={`sugg-${team.id}`}
          onChange={(e) => setName(e.target.value)}
          aria-label="Team name"
        />
        <datalist id={`sugg-${team.id}`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button className="btn btn--small btn--secondary" disabled={!name.trim() || name === team.name}>
          Save name
        </button>
      </form>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          run("team.update", { teamId: team.id, motto }, "Motto saved");
        }}
      >
        <input
          className="input input--small"
          value={motto}
          maxLength={MOTTO_MAX}
          placeholder="Motto (optional)"
          onChange={(e) => setMotto(e.target.value)}
          aria-label="Team motto"
        />
        <button className="btn btn--small btn--secondary" disabled={motto === team.motto}>
          Save motto
        </button>
      </form>

      <div className="team-editor__look">
        <div className="swatches" role="radiogroup" aria-label="Team colour">
          {TEAM_COLOURS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={team.colour === c}
              className={`swatch${team.colour === c ? " is-selected" : ""}`}
              style={{ background: c }}
              onClick={() => run("team.update", { teamId: team.id, colour: c })}
              aria-label={`Colour ${c}`}
            />
          ))}
        </div>
        <select
          className="input input--small"
          value={team.badge}
          onChange={(e) => run("team.update", { teamId: team.id, badge: e.target.value })}
          aria-label="Team badge"
        >
          {[...TEAM_BADGES, ...EXTRA_BADGES].map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}

function ResetDialog({ onClose, run }: { onClose: () => void; run: Run }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("draw.reset", { confirm: text }, "Draw reset");
          ref.current?.close();
        }}
      >
        <h2 className="dialog__title">Reset the team draw?</h2>
        <p>Every team, team name and motto will be cleared, and the guest list goes back to the draw set-up.</p>
        <label className="field">
          <span className="field__label">Type RESET to confirm</span>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={() => ref.current?.close()}>
            Keep the teams
          </button>
          <button className="btn btn--danger-solid" disabled={text !== "RESET"}>
            Reset the draw
          </button>
        </div>
      </form>
    </dialog>
  );
}

// ---------------------------------------------------------------------------

function ActivityLog({ view }: { view: HostView }) {
  return (
    <details className="log">
      <summary className="log__summary">Activity log</summary>
      <ol className="log__list">
        {view.audit.map((a, i) => (
          <li key={`${a.at}-${i}`}>
            <time className="log__time">{new Date(a.at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            <span>{a.detail}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

// ---------------------------------------------------------------------------

function StartFresh({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [clearGuests, setClearGuests] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
  }, [open]);
  return (
    <>
      <button className="btn btn--ghost btn--danger btn--small" onClick={() => setOpen(true)}>
        Start fresh
      </button>
      {open && (
        <dialog
          ref={ref}
          className="dialog"
          onClose={() => {
            setOpen(false);
            setText("");
            setClearGuests(false);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run("event.startFresh", { confirm: text, clearGuests }, "Started fresh");
              if (ok !== undefined) ref.current?.close();
            }}
          >
            <h2 className="dialog__title">Start fresh?</h2>
            <p>This clears the team draw, team names, every point and the leaderboard, and removes test guests. Your activities and the guest link stay the same.</p>
            <label className="check">
              <input type="checkbox" checked={clearGuests} onChange={(e) => setClearGuests(e.target.checked)} />
              <span>Also remove everyone from the guest list, with their photos</span>
            </label>
            <label className="field">
              <span className="field__label">Type START FRESH to confirm</span>
              <input className="input" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </label>
            <div className="dialog__actions">
              <button type="button" className="btn btn--ghost" onClick={() => ref.current?.close()}>
                Keep everything
              </button>
              <button className="btn btn--danger-solid" disabled={text !== "START FRESH"}>
                Start fresh
              </button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}
