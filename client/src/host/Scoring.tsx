import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ACTIVITY_NAME_MAX,
  MAX_POINTS,
  REASON_MAX,
  UNDO_MS,
  ordinal,
  signed,
  teamDisplayName,
  type ActivityKind,
  type ActivityView,
  type HostPlayer,
  type HostView,
  type LedgerEntryView,
  type PublicTeam,
  type ScoringScheme,
} from "../../../shared/types";
import { useTicker } from "../net";
import { Avatar, formatClock, teamStyle } from "../ui";

/** Sends an action; resolves to its data (or true) on success, undefined on failure. */
export type Run = <T = unknown>(action: string, payload?: Record<string, unknown>, okText?: string) => Promise<T | undefined>;
export type Notify = (toast: { kind: "ok" | "error"; text: string; action?: { label: string; onClick: () => void }; ms?: number }) => void;

type Selection = { type: "activity"; id: string } | { type: "new" } | { type: "edit"; id: string } | { type: "adjust" } | null;

interface Props {
  view: HostView;
  run: Run;
  notify: Notify;
  serverNow: () => number;
}

export function ScoringPanel({ view, run, notify, serverNow }: Props) {
  const ready = view.draw.phase === "complete";
  const [sel, setSel] = useState<Selection>(() => (view.activities[0] ? { type: "activity", id: view.activities[0].id } : null));
  const players = useMemo(() => new Map(view.roster.map((p) => [p.id, p])), [view.roster]);
  const teams = useMemo(() => new Map(view.teams.map((t) => [t.id, t])), [view.teams]);

  // If the selected activity disappears, fall back to the first one.
  useEffect(() => {
    if ((sel?.type === "activity" || sel?.type === "edit") && !view.activities.some((a) => a.id === sel.id)) {
      setSel(view.activities[0] ? { type: "activity", id: view.activities[0].id } : null);
    }
  }, [sel, view.activities]);

  /** Awards points and offers a 10-second undo. */
  const scored = async (action: string, payload: Record<string, unknown>, label: string) => {
    const data = await run<{ entryId: string }>(action, payload);
    if (!data?.entryId) return;
    notify({
      kind: "ok",
      text: label,
      ms: UNDO_MS,
      action: { label: "Undo", onClick: () => run("score.void", { entryId: data.entryId }, "Undone") },
    });
  };

  const selected = sel?.type === "activity" ? view.activities.find((a) => a.id === sel.id) : undefined;
  const editing = sel?.type === "edit" ? view.activities.find((a) => a.id === sel.id) : undefined;

  return (
    <section className="panel scoring" aria-labelledby="scoring-h">
      <header className="panel__head">
        <h2 id="scoring-h" className="panel__title">
          Scoring
        </h2>
        <span className="panel__meta">On the TV: {tvStatus(view)}</span>
      </header>

      {ready && <TvControls view={view} run={run} />}

      <div className="scoring__grid">
        <aside className="scoring__side">
          <nav className="activity-list" aria-label="Activities">
            {view.activities.map((a) => {
              const pts = view.ledger.filter((e) => e.activityId === a.id && !e.voided).length;
              const isOn = view.stage.activityId === a.id && (view.stage.screen === "activity" || view.stage.screen === "results");
              return (
                <button
                  key={a.id}
                  className={`activity-list__item${sel?.type === "activity" && sel.id === a.id ? " is-selected" : ""}`}
                  aria-current={sel?.type === "activity" && sel.id === a.id ? "true" : undefined}
                  onClick={() => setSel({ type: "activity", id: a.id })}
                >
                  <span className="activity-list__name">{a.name}</span>
                  <span className="activity-list__meta">
                    {a.kind === "team" ? "Team" : "Individual"} · {schemeSummary(a)}
                    {pts > 0 && ` · ${pts} scored`}
                    {isOn && <span className="tag tag--on">on TV</span>}
                    {a.resultsShown && !isOn && <span className="tag">results shown</span>}
                  </span>
                </button>
              );
            })}
            {view.activities.length === 0 && (
              <p className="host__muted">Plan the day's games here. You can add them now and score them on the day.</p>
            )}
          </nav>
          <div className="scoring__side-actions">
            <button className={`btn btn--secondary${sel?.type === "new" ? " is-active" : ""}`} onClick={() => setSel({ type: "new" })}>
              New activity
            </button>
            {ready && (
              <button className={`btn btn--secondary${sel?.type === "adjust" ? " is-active" : ""}`} onClick={() => setSel({ type: "adjust" })}>
                Bonus or penalty
              </button>
            )}
          </div>
          {ready && <TotalsTable view={view} />}
        </aside>

        <div className="scoring__main">
          {sel?.type === "new" && (
            <ActivityForm
              run={run}
              onDone={(id) => setSel(id ? { type: "activity", id } : view.activities[0] ? { type: "activity", id: view.activities[0].id } : null)}
            />
          )}
          {editing && <ActivityForm run={run} activity={editing} onDone={() => setSel({ type: "activity", id: editing.id })} />}
          {selected && (
            <ActivityPad
              activity={selected}
              view={view}
              run={run}
              scored={scored}
              players={players}
              serverNow={serverNow}
              onEdit={() => setSel({ type: "edit", id: selected.id })}
            />
          )}
          {sel?.type === "adjust" && <AdjustForm view={view} players={players} scored={scored} />}
          {!sel && <p className="host__muted scoring__empty">Choose an activity, or add a new one.</p>}
          {(selected || sel?.type === "adjust") && (
            <History
              entries={view.ledger.filter((e) => (selected ? e.activityId === selected.id : e.activityId === null))}
              players={players}
              teams={teams}
              run={run}
              title={selected ? `Points in ${selected.name}` : "Bonuses and penalties"}
            />
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function tvStatus(view: HostView): string {
  if (view.intermission) return "Intermission";
  if (view.draw.phase === "draft") return "Arrivals";
  if (view.draw.phase !== "complete") return "The team draw";
  const a = view.activities.find((x) => x.id === view.stage.activityId);
  switch (view.stage.screen) {
    case "activity":
      return a?.name ?? "An activity";
    case "results":
      return `${a?.name ?? "Activity"} results`;
    case "standings":
      return view.blackout ? "Leaderboard (frozen)" : "Leaderboard";
    case "final":
      return "Final results";
    default:
      return view.naming.phase === "open" ? "Team naming" : "The teams";
  }
}

function schemeSummary(a: Pick<ActivityView, "scoring" | "placements" | "perCorrect">): string {
  if (a.scoring === "placement") return a.placements.map((p, i) => `${ordinal(i + 1)} ${p}`).join(", ");
  if (a.scoring === "perCorrect") return `${a.perCorrect} per correct answer`;
  return "Host judges";
}

function TvControls({ view, run }: { view: HostView; run: Run }) {
  const screen = view.stage.screen;
  return (
    <div className="tv-controls" role="group" aria-label="What's on the TV">
      <button className={`btn btn--small ${screen === "teams" ? "btn--on" : "btn--ghost"}`} onClick={() => run("stage.show", { screen: "teams" })}>
        Show the teams
      </button>
      <button
        className={`btn btn--small ${screen === "standings" || screen === "final" ? "btn--on" : "btn--ghost"}`}
        disabled={!view.standings}
        onClick={() => run("stage.show", { screen: "standings" })}
      >
        Show the leaderboard
      </button>
      <label className="switch">
        <input type="checkbox" checked={view.blackout} onChange={(e) => run("standings.blackout", { on: e.target.checked })} />
        <span>Blackout (freeze the leaderboard until the finale)</span>
      </label>
      <button
        className="btn btn--small btn--ghost btn--finale"
        disabled={!view.ledger.some((e) => !e.voided)}
        onClick={() => {
          if (confirm("Reveal the final results? Every point so far goes on the TV, from last place up, then the winners.")) {
            run("standings.final");
          }
        }}
      >
        Reveal the final results
      </button>
    </div>
  );
}

function TotalsTable({ view }: { view: HostView }) {
  const shown = new Map(view.standings?.rows.map((r) => [r.teamId, r.points]) ?? []);
  const rows = [...view.teams].sort((a, b) => (view.liveTotals[b.id] ?? 0) - (view.liveTotals[a.id] ?? 0) || a.order - b.order);
  return (
    <table className="totals">
      <caption className="totals__caption">Team totals</caption>
      <thead>
        <tr>
          <th scope="col">Team</th>
          <th scope="col" className="num">
            On the TV
          </th>
          <th scope="col" className="num">
            Actual
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => {
          const live = view.liveTotals[t.id] ?? 0;
          const tv = shown.get(t.id);
          return (
            <tr key={t.id} style={teamStyle(t)}>
              <th scope="row" className="totals__team">
                {t.badge} {teamDisplayName(t)}
              </th>
              <td className="num">{tv ?? "–"}</td>
              <td className={`num${tv !== undefined && tv !== live ? " totals__changed" : ""}`}>{live}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// One activity

interface PadProps {
  activity: ActivityView;
  view: HostView;
  run: Run;
  scored: (action: string, payload: Record<string, unknown>, label: string) => Promise<void>;
  players: Map<string, HostPlayer>;
  serverNow: () => number;
  onEdit: () => void;
}

function ActivityPad({ activity: a, view, run, scored, players, serverNow, onEdit }: PadProps) {
  const ready = view.draw.phase === "complete";
  const entries = view.ledger.filter((e) => e.activityId === a.id && !e.voided);
  const onTv = view.stage.activityId === a.id && view.stage.screen === "activity";
  const hasPoints = entries.length > 0;

  return (
    <div className="pad">
      <header className="pad__head">
        <div>
          <h3 className="pad__title">{a.name}</h3>
          <p className="host__muted pad__summary">
            {a.kind === "team" ? "Teams play together" : "Everyone plays for their team"} · {schemeSummary(a)}
            {a.timerSeconds ? ` · ${formatClock(a.timerSeconds * 1000)} timer` : ""}
          </p>
        </div>
        <div className="pad__tools">
          <button className="btn btn--small btn--ghost" onClick={onEdit}>
            Edit
          </button>
          {!hasPoints && (
            <button
              className="btn btn--small btn--ghost"
              onClick={() => {
                if (confirm(`Remove ${a.name}?`)) run("activity.delete", { id: a.id });
              }}
            >
              Remove
            </button>
          )}
        </div>
      </header>

      <div className="pad__tv">
        <button className={`btn btn--small ${onTv ? "btn--on" : "btn--secondary"}`} onClick={() => run("stage.show", { screen: "activity", activityId: a.id })}>
          {onTv ? "On the TV now" : "Show on the TV"}
        </button>
        {onTv && <TimerControls view={view} run={run} serverNow={serverNow} />}
        <button
          className="btn btn--small btn--secondary"
          disabled={!hasPoints}
          onClick={() => run("results.show", { activityId: a.id })}
          title={hasPoints ? undefined : "Award some points first"}
        >
          {a.resultsShown ? "Show the results again" : "Show the results on the TV"}
        </button>
      </div>

      {!ready ? (
        <p className="callout">You can award points once the teams are drawn.</p>
      ) : (
        <div className="pad__teams">
          {view.teams.map((t) => (
            <TeamPad key={t.id} team={t} activity={a} entries={entries.filter((e) => e.teamId === t.id)} players={players} run={run} scored={scored} />
          ))}
        </div>
      )}
    </div>
  );
}

function TimerControls({ view, run, serverNow }: { view: HostView; run: Run; serverNow: () => number }) {
  const t = view.stage.timer;
  useTicker(250, !!t?.endsAt);
  const [custom, setCustom] = useState("60");
  if (!t) {
    return (
      <form
        className="timer-controls"
        onSubmit={(e) => {
          e.preventDefault();
          run("stage.timer", { action: "set", seconds: Number(custom) });
        }}
      >
        <input className="input input--small input--num" type="number" min={5} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Timer length in seconds" />
        <button className="btn btn--small btn--ghost">Add a timer (seconds)</button>
      </form>
    );
  }
  const left = t.endsAt ? t.endsAt - serverNow() : (t.remainingMs ?? t.durationMs);
  return (
    <div className="timer-controls">
      <span className={`timer-controls__clock${t.endsAt && left <= 10_000 ? " is-low" : ""}`}>{formatClock(left)}</span>
      {t.endsAt ? (
        <button className="btn btn--small btn--secondary" onClick={() => run("stage.timer", { action: "pause" })}>
          Pause
        </button>
      ) : (
        <button className="btn btn--small btn--primary" onClick={() => run("stage.timer", { action: "start" })}>
          {left > 0 && left < t.durationMs ? "Resume" : "Start the timer"}
        </button>
      )}
      <button className="btn btn--small btn--ghost" onClick={() => run("stage.timer", { action: "reset" })}>
        Reset
      </button>
    </div>
  );
}

interface TeamPadProps {
  team: PublicTeam;
  activity: ActivityView;
  entries: LedgerEntryView[];
  players: Map<string, HostPlayer>;
  run: Run;
  scored: PadProps["scored"];
}

function TeamPad({ team, activity: a, entries, players, run, scored }: TeamPadProps) {
  const total = entries.reduce((n, e) => n + e.points, 0);
  const members = team.memberIds.map((id) => players.get(id)).filter((p): p is HostPlayer => !!p);
  const [earner, setEarner] = useState<string | null>(null);
  const name = teamDisplayName(team);

  return (
    <article className="team-pad" style={teamStyle(team)}>
      <header className="team-pad__head">
        <span className="team-pad__name">
          {team.badge} {name}
        </span>
        <span className="team-pad__total">{signed(total)}</span>
      </header>
      {a.kind === "team" ? (
        <>
          {members.length > 1 && (
            <div className="earner" role="radiogroup" aria-label={`Who earned it (optional) for ${name}`}>
              {members.map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={earner === p.id}
                  className={`earner__chip${earner === p.id ? " is-selected" : ""}`}
                  onClick={() => setEarner(earner === p.id ? null : p.id)}
                  title={`Credit ${p.name}`}
                >
                  <Avatar player={p} /> {p.name}
                </button>
              ))}
            </div>
          )}
          <ScoreControls
            activity={a}
            entries={entries}
            recipient={earner ? `${name} (${players.get(earner)?.name})` : name}
            award={(payload, label) => {
              scored("score.award", { activityId: a.id, teamId: team.id, playerId: earner, ...payload }, label);
              setEarner(null);
            }}
            run={run}
          />
        </>
      ) : (
        <ul className="team-pad__members">
          {members.map((p) => {
            const mine = entries.filter((e) => e.playerId === p.id);
            return (
              <li key={p.id} className="team-pad__member">
                <span className="team-pad__member-name">
                  <Avatar player={p} /> {p.name}
                  <span className="host__muted">{signed(mine.reduce((n, e) => n + e.points, 0))}</span>
                </span>
                <ScoreControls
                  activity={a}
                  entries={mine}
                  recipient={`${name} (${p.name})`}
                  compact
                  award={(payload, label) => scored("score.award", { activityId: a.id, teamId: team.id, playerId: p.id, ...payload }, label)}
                  run={run}
                />
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

interface ScoreControlsProps {
  activity: ActivityView;
  /** Live entries for this team (or this guest, in individual activities). */
  entries: LedgerEntryView[];
  recipient: string;
  compact?: boolean;
  award: (payload: Record<string, unknown>, label: string) => void;
  run: Run;
}

function ScoreControls({ activity: a, entries, recipient, compact, award, run }: ScoreControlsProps) {
  const [custom, setCustom] = useState("");
  if (a.scoring === "placement") {
    const held = entries.find((e) => e.placement !== null);
    return (
      <div className={`place-chips${compact ? " place-chips--compact" : ""}`}>
        {a.placements.map((pts, i) => {
          const place = i + 1;
          const isHeld = held?.placement === place;
          return (
            <button
              key={place}
              className={`place-chip${isHeld ? " is-held" : ""}`}
              aria-pressed={isHeld}
              aria-label={isHeld ? `Remove ${ordinal(place)} place from ${recipient}` : `${ordinal(place)} place: +${pts} → ${recipient}`}
              onClick={() => {
                if (isHeld) run("score.void", { entryId: held!.id }, `Removed ${ordinal(place)} place`);
                else award({ placement: place }, `${ordinal(place)} place: +${pts} → ${recipient}`);
              }}
            >
              <span className="place-chip__place">{ordinal(place)}</span>
              <span className="place-chip__pts">+{pts}</span>
            </button>
          );
        })}
      </div>
    );
  }
  if (a.scoring === "perCorrect") {
    const count = entries.length;
    const last = entries.reduce<LedgerEntryView | null>((acc, e) => (!acc || e.at > acc.at ? e : acc), null);
    return (
      <div className="counter">
        <button className="btn btn--small btn--ghost" disabled={!last} onClick={() => last && run("score.void", { entryId: last.id })} aria-label={`Take one away from ${recipient}`}>
          −1
        </button>
        <span className="counter__count" aria-live="polite">
          {count} correct
        </span>
        <button className="btn btn--small btn--primary" onClick={() => award({}, `Correct: +${a.perCorrect} → ${recipient}`)}>
          +{a.perCorrect} correct
        </button>
      </div>
    );
  }
  const n = Number(custom);
  const valid = Number.isInteger(n) && n !== 0 && Math.abs(n) <= MAX_POINTS;
  return (
    <div className={`judged${compact ? " judged--compact" : ""}`}>
      {[1, 2, 3, 5].map((v) => (
        <button key={v} className="btn btn--small btn--ghost" onClick={() => award({ points: v }, `+${v} → ${recipient}`)}>
          +{v}
        </button>
      ))}
      <form
        className="judged__custom"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          award({ points: n }, `${signed(n)} → ${recipient}`);
          setCustom("");
        }}
      >
        <input
          className="input input--small input--num"
          type="number"
          inputMode="numeric"
          value={custom}
          placeholder="Other"
          onChange={(e) => setCustom(e.target.value)}
          aria-label={`Other amount for ${recipient}`}
        />
        <button className="btn btn--small btn--secondary" disabled={!valid}>
          {valid ? `${signed(n)} → ${compact ? "award" : recipient}` : "Award"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bonuses and penalties

function AdjustForm({ view, players, scored }: { view: HostView; players: Map<string, HostPlayer>; scored: PadProps["scored"] }) {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string>("");
  const [sign, setSign] = useState<1 | -1>(1);
  const [amount, setAmount] = useState("3");
  const [reason, setReason] = useState("");
  const team = view.teams.find((t) => t.id === teamId);
  const n = Number(amount) * sign;
  const valid = !!team && Number.isInteger(n) && n !== 0 && Math.abs(n) <= MAX_POINTS && reason.trim().length > 0;
  const who = playerId ? players.get(playerId)?.name : null;
  const label = team ? `${signed(n)} → ${teamDisplayName(team)}${who ? ` (${who})` : ""}` : "Choose a team";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !team) return;
    await scored("score.adjust", { teamId: team.id, playerId: playerId || null, points: n, reason }, `${label}: ${reason.trim()}`);
    setReason("");
  };

  return (
    <form className="pad adjust" onSubmit={submit}>
      <h3 className="pad__title">Bonus or penalty</h3>
      <div className="adjust__teams" role="radiogroup" aria-label="Team">
        {view.teams.map((t) => (
          <button
            type="button"
            key={t.id}
            role="radio"
            aria-checked={teamId === t.id}
            className={`adjust__team${teamId === t.id ? " is-selected" : ""}`}
            style={teamStyle(t)}
            onClick={() => {
              setTeamId(t.id);
              setPlayerId("");
            }}
          >
            {t.badge} {teamDisplayName(t)}
          </button>
        ))}
      </div>
      <div className="adjust__row">
        <div className="segmented" role="radiogroup" aria-label="Bonus or penalty">
          <button type="button" role="radio" aria-checked={sign === 1} className={sign === 1 ? "is-selected" : ""} onClick={() => setSign(1)}>
            Bonus
          </button>
          <button type="button" role="radio" aria-checked={sign === -1} className={sign === -1 ? "is-selected" : ""} onClick={() => setSign(-1)}>
            Penalty
          </button>
        </div>
        <label className="field field--inline">
          <span className="field__label">Points</span>
          <input className="input input--small input--num" type="number" min={1} max={MAX_POINTS} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {team && team.memberIds.length > 0 && (
          <label className="field field--inline">
            <span className="field__label">Earned by (optional)</span>
            <select className="input input--small" value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
              <option value="">The whole team</option>
              {team.memberIds.map((id) => (
                <option key={id} value={id}>
                  {players.get(id)?.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="field">
        <span className="field__label">Reason (shown in the points history)</span>
        <input className="input" value={reason} maxLength={REASON_MAX} placeholder={sign === 1 ? "Best costume" : "Phone at the dinner table"} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="btn btn--primary" disabled={!valid}>
        {label}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Creating and editing activities

function ActivityForm({ run, activity, onDone }: { run: Run; activity?: ActivityView; onDone: (id?: string) => void }) {
  const [name, setName] = useState(activity?.name ?? "");
  const [kind, setKind] = useState<ActivityKind>(activity?.kind ?? "team");
  const [scoring, setScoring] = useState<ScoringScheme>(activity?.scoring ?? "placement");
  const [placements, setPlacements] = useState((activity?.placements ?? [5, 3, 1]).join(", "));
  const [perCorrect, setPerCorrect] = useState(String(activity?.perCorrect ?? 1));
  const [description, setDescription] = useState(activity?.description ?? "");
  const [timer, setTimer] = useState(activity?.timerSeconds ? String(activity.timerSeconds) : "");
  const [busy, setBusy] = useState(false);

  const parsedPlaces = placements
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const payload = {
      name,
      kind,
      scoring,
      placements: parsedPlaces,
      perCorrect: Number(perCorrect) || 1,
      description,
      timerSeconds: Number(timer) || 0,
    };
    const res = activity
      ? await run("activity.update", { id: activity.id, ...payload }, "Activity saved")
      : await run<{ id: string }>("activity.create", payload, "Activity added");
    setBusy(false);
    if (res === undefined) return;
    onDone(activity ? undefined : (res as { id: string }).id);
  };

  return (
    <form className="pad activity-form" onSubmit={submit}>
      <h3 className="pad__title">{activity ? `Edit ${activity.name}` : "New activity"}</h3>
      <label className="field">
        <span className="field__label">Name</span>
        <input className="input" value={name} maxLength={ACTIVITY_NAME_MAX} placeholder="Name of the game" onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      <Fieldset legend="Who plays">
        <Radio name="kind" checked={kind === "team"} onChange={() => setKind("team")} title="Teams" body="Each pair plays together. You can still credit the player who earned the points." />
        <Radio name="kind" checked={kind === "individual"} onChange={() => setKind("individual")} title="Individuals" body="Everyone plays alone, and their points go to their team." />
      </Fieldset>
      <Fieldset legend="How it's scored">
        <Radio name="scoring" checked={scoring === "placement"} onChange={() => setScoring("placement")} title="Places" body="Points for 1st, 2nd, 3rd…" />
        <Radio name="scoring" checked={scoring === "perCorrect"} onChange={() => setScoring("perCorrect")} title="Correct answers" body="The same points for every correct answer." />
        <Radio name="scoring" checked={scoring === "judged"} onChange={() => setScoring("judged")} title="You judge" body="Award any amount as you go." />
      </Fieldset>
      {scoring === "placement" && (
        <label className="field">
          <span className="field__label">Points for each place, best first</span>
          <input className="input" value={placements} onChange={(e) => setPlacements(e.target.value)} placeholder="5, 3, 1" />
          <span className="host__muted">
            {parsedPlaces.every((p) => Number.isInteger(p) && p >= 0)
              ? parsedPlaces.map((p, i) => `${ordinal(i + 1)}: ${p}`).join(" · ")
              : "Use whole numbers separated by commas."}
          </span>
        </label>
      )}
      {scoring === "perCorrect" && (
        <label className="field field--inline">
          <span className="field__label">Points per correct answer</span>
          <input className="input input--small input--num" type="number" min={1} value={perCorrect} onChange={(e) => setPerCorrect(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span className="field__label">Instructions for players' phones (optional)</span>
        <textarea
          className="input input--area"
          rows={5}
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Write the rules players will see on their phones. Put each rule on its own line."
        />
        <span className="host__muted">The TV shows only the game's name. Players see these on their phones when you show the game on the TV.</span>
      </label>
      <label className="field field--inline">
        <span className="field__label">Timer in seconds (optional)</span>
        <input className="input input--small input--num" type="number" min={0} value={timer} onChange={(e) => setTimer(e.target.value)} placeholder="None" />
      </label>
      <div className="activity-form__actions">
        <button type="button" className="btn btn--ghost" onClick={() => onDone()}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy || !name.trim()}>
          {activity ? "Save changes" : "Add activity"}
        </button>
      </div>
    </form>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="choice">
      <legend className="choice__legend">{legend}</legend>
      <div className="choice__row">{children}</div>
    </fieldset>
  );
}

function Radio({ name, checked, onChange, title, body }: { name: string; checked: boolean; onChange: () => void; title: string; body: string }) {
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

function History({
  entries,
  players,
  teams,
  run,
  title,
}: {
  entries: LedgerEntryView[];
  players: Map<string, HostPlayer>;
  teams: Map<string, PublicTeam>;
  run: Run;
  title: string;
}) {
  if (!entries.length) return null;
  return (
    <details className="history" open>
      <summary className="history__summary">
        {title} ({entries.filter((e) => !e.voided).length})
      </summary>
      <ol className="history__list">
        {entries.map((e) => {
          const team = teams.get(e.teamId);
          const who = e.playerId ? players.get(e.playerId)?.name : null;
          return (
            <li key={e.id} className={`history__row${e.voided ? " is-voided" : ""}`} style={team ? teamStyle(team) : undefined}>
              <time className="log__time">{new Date(e.at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</time>
              <span className={`history__pts${e.points < 0 ? " is-neg" : ""}`}>{signed(e.points)}</span>
              <span className="history__what">
                <span className="history__team">{team ? teamDisplayName(team) : "Removed team"}</span>
                {who && ` (${who})`} · {e.reason}
              </span>
              <span className="history__tags">
                {e.voided ? <span className="tag">voided</span> : !e.revealed && <span className="tag">not shown yet</span>}
              </span>
              <button
                className="btn btn--small btn--ghost"
                onClick={() => run(e.voided ? "score.restore" : "score.void", { entryId: e.id }, e.voided ? "Restored" : "Voided")}
              >
                {e.voided ? "Restore" : "Void"}
              </button>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
