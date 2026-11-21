// Polls in the control room (Block 4): running them (presenter view, with the
// votes coming in live) and writing them. "Who wrote this?" rounds are built
// by picking guests' secret facts and putting them in order.

import { useMemo, useState, type FormEvent } from "react";
import {
  MAX_OPTIONS,
  OPTION_MAX,
  POLL_OPTIONS_KIND_LABEL,
  POLL_SCORING_LABEL,
  QUESTION_MAX,
  teamDisplayName,
  type ActivityView,
  type HostPlayer,
  type HostView,
  type PollOptionsKind,
  type PollQuestionView,
  type PollScoring,
} from "../../../shared/types";
import { useTicker } from "../net";
import { Avatar, formatClock } from "../ui";
import type { Run } from "./Scoring";

interface Props {
  activity: ActivityView;
  view: HostView;
  run: Run;
  players: Map<string, HostPlayer>;
  serverNow: () => number;
}

export function pollSummary(a: ActivityView): string {
  const time = a.questionSeconds ? `${a.questionSeconds} seconds per question` : "no timer";
  if (a.pollKind === "whowrote") {
    return [
      "Guess whose secret fact it is",
      `${a.perCorrect} ${a.perCorrect === 1 ? "point" : "points"} per right guess`,
      a.foolBonus ? `+${a.foolBonus} for the writer who fools the most people` : null,
      time,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return ["Everyone votes on their phone", time].join(" · ");
}

/** Fact id → its text and writer, from everyone's questionnaire. */
function useFacts(view: HostView) {
  return useMemo(() => {
    const m = new Map<string, { text: string; playerId: string }>();
    for (const [playerId, q] of Object.entries(view.questionnaires)) for (const f of q.facts) m.set(f.id, { text: f.text, playerId });
    return m;
  }, [view.questionnaires]);
}

export function PollPad(props: Props) {
  const questions = props.view.polls[props.activity.id] ?? [];
  const [tab, setTab] = useState<"run" | "questions">(questions.length ? "run" : "questions");
  return (
    <div className="quiz-pad">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "run"} className={`tabs__tab${tab === "run" ? " is-selected" : ""}`} onClick={() => setTab("run")}>
          Run the poll
        </button>
        <button role="tab" aria-selected={tab === "questions"} className={`tabs__tab${tab === "questions" ? " is-selected" : ""}`} onClick={() => setTab("questions")}>
          {props.activity.pollKind === "whowrote" ? "Facts" : "Questions"} ({questions.length})
        </button>
      </div>
      {tab === "run" ? (
        <Presenter {...props} onEdit={() => setTab("questions")} />
      ) : props.activity.pollKind === "whowrote" ? (
        <FactPicker {...props} />
      ) : (
        <PollBank {...props} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presenter

function Presenter({ activity: a, view, run, players, serverNow, onEdit }: Props & { onEdit: () => void }) {
  const questions = view.polls[a.id] ?? [];
  const revealed = new Set(view.revealedQuestions[a.id] ?? []);
  const facts = useFacts(view);
  const live = view.poll && view.poll.activityId === a.id ? view.poll : null;
  const q = live && live.index >= 0 ? questions[live.index] : undefined;
  const nextIndex = live ? live.index + 1 : -1;
  useTicker(250, live?.phase === "open");

  if (!questions.length) {
    return (
      <div className="callout">
        <p>{a.pollKind === "whowrote" ? "Choose some secret facts first." : "This poll has no questions yet."}</p>
        <button className="btn btn--small btn--secondary" onClick={onEdit}>
          {a.pollKind === "whowrote" ? "Choose facts" : "Add questions"}
        </button>
      </div>
    );
  }

  const title = (x: PollQuestionView) => (x.factId ? `“${facts.get(x.factId)?.text ?? "(fact removed)"}”` : x.prompt);

  if (!live) {
    const played = questions.filter((x) => revealed.has(x.id)).length;
    return (
      <div className="presenter">
        <p className="host__muted">
          {questions.length} {questions.length === 1 ? "question" : "questions"}{played ? `, ${played} played so far` : ""}.
        </p>
        <button className="btn btn--primary" disabled={view.draw.phase !== "complete"} onClick={() => run("poll.start", { activityId: a.id })}>
          {played ? "Put the poll back on the TV" : "Start the poll on the TV"}
        </button>
        {view.draw.phase !== "complete" && <p className="host__muted">You can start it once the teams are drawn.</p>}
      </div>
    );
  }

  const left = live.endsAt ? live.endsAt - serverNow() : null;
  const writer = q?.factId ? players.get(facts.get(q.factId)?.playerId ?? "") : undefined;
  const voterCount = view.roster.filter((p) => p.teamId && p.status !== "pending").length - (writer ? 1 : 0);
  const next = questions[nextIndex];

  return (
    <div className="presenter">
      {live.phase === "intro" || !q ? (
        <div className="presenter__card">
          <p className="presenter__meta">The TV shows the round's title. Open the first question when everyone's ready.</p>
          {next && <p className="next-up__prompt">Next: {title(next)}</p>}
        </div>
      ) : (
        <div className="presenter__card">
          <div className="presenter__meta">
            <span>
              Question {live.index + 1} of {questions.length}
              {!q.factId && ` · ${POLL_SCORING_LABEL[q.scoring]}${q.scoring !== "none" ? ` (${q.points})` : ""}`}
            </span>
            <span className={`phase phase--${live.phase}`}>
              {live.phase === "open" ? (left !== null ? `Open · ${formatClock(left)}` : "Open · no timer") : live.phase === "closed" ? "Voting closed" : "Votes revealed"}
            </span>
          </div>
          <p className="qbody__prompt">{title(q)}</p>
          {writer && (
            <p className="host__muted">
              Written by <strong>{writer.name}</strong> (only you can see this)
            </p>
          )}
          <div className="presenter__actions">
            {live.phase === "open" && (
              <button className="btn btn--secondary" onClick={() => run("poll.close")}>
                Close voting now
              </button>
            )}
            {(live.phase === "closed" || live.phase === "open") && (
              <button className="btn btn--primary" onClick={() => run("poll.reveal")}>
                Reveal the votes
              </button>
            )}
            {live.phase === "closed" && (
              <button className="btn btn--ghost" onClick={() => run("poll.reopen", { seconds: 15 })}>
                Reopen for 15 seconds
              </button>
            )}
          </div>
          <LiveVotes view={view} players={players} total={voterCount} correctKey={writer?.id ?? null} />
        </div>
      )}

      {live.phase === "revealed" && q && (
        <div className="presenter__actions">
          {next ? (
            <button className="btn btn--primary" onClick={() => run("poll.open")}>
              Open question {live.index + 2}
            </button>
          ) : (
            <button className="btn btn--primary" onClick={() => run("results.show", { activityId: a.id })}>
              Show the round results on the TV
            </button>
          )}
        </div>
      )}

      <details className="presenter__list">
        <summary>All questions</summary>
        <ol className="qlist">
          {questions.map((x, i) => (
            <li key={x.id} className={`qlist__row${live.index === i ? " is-current" : ""}`}>
              <span className="qlist__num">{i + 1}</span>
              <span className="qlist__prompt">{title(x)}</span>
              <span className="host__muted">{revealed.has(x.id) ? "played" : ""}</span>
              <button
                className="btn btn--small btn--ghost"
                disabled={live.phase === "open"}
                onClick={() => {
                  if (revealed.has(x.id) && !confirm(`Play question ${i + 1} again? Its votes and points will be cleared.`)) return;
                  run("poll.open", { index: i });
                }}
              >
                {revealed.has(x.id) ? "Replay" : "Play now"}
              </button>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** The votes so far, grouped by option. Only the control room sees these before the reveal. */
function LiveVotes({ view, players, total, correctKey }: { view: HostView; players: Map<string, HostPlayer>; total: number; correctKey: string | null }) {
  const poll = view.poll!;
  const options = poll.question?.options ?? [];
  const byKey = new Map<string, string[]>();
  for (const v of view.pollVotes) byKey.set(v.key, [...(byKey.get(v.key) ?? []), v.voterId]);
  const teams = new Map(view.teams.map((t) => [t.id, t]));
  const label = (key: string) => {
    const o = options.find((x) => x.key === key);
    const t = teams.get(key);
    return t ? teamDisplayName(t) : (o?.label ?? key);
  };
  const keys = options.map((o) => o.key).filter((k) => byKey.has(k)).sort((x, y) => (byKey.get(y)!.length - byKey.get(x)!.length));
  return (
    <div className="live-votes">
      <p className="host__muted">
        {view.pollVotes.length} of {Math.max(total, 0)} voted
      </p>
      <ul className="plain-list">
        {keys.map((k) => (
          <li key={k} className={`live-votes__row${k === correctKey ? " is-correct" : ""}`}>
            <span className="live-votes__option">
              {players.get(k) && <Avatar player={players.get(k)!} />} {label(k)}
            </span>
            <span className="live-votes__count">{byKey.get(k)!.length}</span>
            <span className="live-votes__voters">
              {byKey.get(k)!.map((id) => {
                const p = players.get(id);
                return p ? <Avatar key={id} player={p} /> : null;
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Writing general polls

function PollBank({ activity: a, view, run }: Props) {
  const questions = view.polls[a.id] ?? [];
  const revealed = new Set(view.revealedQuestions[a.id] ?? []);
  const [editing, setEditing] = useState<PollQuestionView | "new" | null>(questions.length ? null : "new");
  return (
    <div className="qbank pollbank">
      <ol className="qlist">
        {questions.map((q, i) => (
          <li key={q.id} className="qlist__row">
            <span className="qlist__num">{i + 1}</span>
            <span className="qlist__prompt">
              {q.prompt}
              <span className="host__muted">
                {" "}
                · {POLL_OPTIONS_KIND_LABEL[q.optionsKind]}
                {q.optionsKind === "custom" && `: ${q.options.join(", ")}`} · {POLL_SCORING_LABEL[q.scoring]}
                {q.scoring !== "none" && ` (${q.points})`}
              </span>
            </span>
            <span className="row__actions">
              <button className="btn btn--small btn--ghost" disabled={i === 0} onClick={() => run("poll.question.move", { activityId: a.id, questionId: q.id, direction: "up" })} aria-label="Move up">
                ↑
              </button>
              <button
                className="btn btn--small btn--ghost"
                disabled={i === questions.length - 1}
                onClick={() => run("poll.question.move", { activityId: a.id, questionId: q.id, direction: "down" })}
                aria-label="Move down"
              >
                ↓
              </button>
              <button className="btn btn--small btn--ghost" disabled={revealed.has(q.id)} onClick={() => setEditing(q)}>
                Edit
              </button>
              <button
                className="btn btn--small btn--ghost"
                onClick={() => confirm("Delete this question?") && run("poll.question.delete", { activityId: a.id, questionId: q.id })}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ol>
      {editing ? (
        <PollForm key={editing === "new" ? "new" : editing.id} activity={a} run={run} q={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
      ) : (
        <button className="btn btn--secondary" onClick={() => setEditing("new")}>
          Add a question
        </button>
      )}
    </div>
  );
}

function PollForm({ activity: a, run, q, onDone }: { activity: ActivityView; run: Run; q: PollQuestionView | null; onDone: () => void }) {
  const [prompt, setPrompt] = useState(q?.prompt ?? "");
  const [optionsKind, setOptionsKind] = useState<PollOptionsKind>(q?.optionsKind ?? "players");
  const [options, setOptions] = useState<string[]>(q?.options.length ? q.options : ["", ""]);
  const [scoring, setScoring] = useState<PollScoring>(q?.scoring ?? "winner");
  const [points, setPoints] = useState(String(q?.points || 3));
  const [seconds, setSeconds] = useState(q?.seconds === null || q?.seconds === undefined ? "" : String(q.seconds));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const question = {
      prompt,
      optionsKind,
      options,
      scoring,
      points: scoring === "none" ? 0 : Number(points) || 0,
      seconds: seconds === "" ? null : Number(seconds),
    };
    if (await run("poll.question.save", { activityId: a.id, questionId: q?.id, question }, q ? "Question saved" : "Question added")) onDone();
  };

  return (
    <form className="qform" onSubmit={submit}>
      <label className="field">
        <span className="field__label">Question</span>
        <input className="input" value={prompt} maxLength={QUESTION_MAX} onChange={(e) => setPrompt(e.target.value)} placeholder="Who's most likely to…" required autoFocus />
      </label>
      <div className="field">
        <span className="field__label">Guests vote for</span>
        <div className="segmented" role="radiogroup">
          {(["players", "teams", "custom"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={optionsKind === k}
              className={optionsKind === k ? "is-selected" : ""}
              onClick={() => {
                setOptionsKind(k);
                if (k === "custom" && scoring === "winner") setScoring("majority");
              }}
            >
              {POLL_OPTIONS_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <span className="host__muted">
          {optionsKind === "players" ? "Every guest, with their photo. Nobody can vote for themselves." : optionsKind === "teams" ? "Every team. Nobody can vote for their own team." : "Up to six options you write."}
        </span>
      </div>
      {optionsKind === "custom" && (
        <div className="qform__options">
          {options.map((o, i) => (
            <div key={i} className="qform__option">
              <input
                className="input input--small"
                value={o}
                maxLength={OPTION_MAX}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {options.length > 2 && (
                <button type="button" className="btn btn--small btn--ghost" onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label="Remove option">
                  ✕
                </button>
              )}
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setOptions([...options, ""])}>
              Add an option
            </button>
          )}
        </div>
      )}
      <div className="field">
        <span className="field__label">Scoring</span>
        <div className="segmented" role="radiogroup">
          {(["winner", "majority", "none"] as const).map((k) => (
            <button
              key={k}
              type="button"
              disabled={k === "winner" && optionsKind === "custom"}
              role="radio"
              aria-checked={scoring === k}
              className={scoring === k ? "is-selected" : ""}
              onClick={() => setScoring(k)}
            >
              {POLL_SCORING_LABEL[k]}
            </button>
          ))}
        </div>
        <span className="host__muted">
          {scoring === "winner"
            ? optionsKind === "teams"
              ? "The team with the most votes gets the points (all of them if tied)."
              : "The guest with the most votes wins the points for their team (all of them if tied)."
            : scoring === "majority"
              ? "Everyone who voted for the most popular answer gets the points for their team."
              : "No points: just for the laughs."}
        </span>
      </div>
      <div className="qform__row">
        {scoring !== "none" && (
          <label className="field field--inline">
            <span className="field__label">Points</span>
            <input className="input input--small input--num" type="number" min={1} value={points} onChange={(e) => setPoints(e.target.value)} />
          </label>
        )}
        <label className="field field--inline">
          <span className="field__label">Seconds (blank for the round's default)</span>
          <input className="input input--small input--num" type="number" min={0} value={seconds} onChange={(e) => setSeconds(e.target.value)} placeholder={String(a.questionSeconds)} />
        </label>
      </div>
      <div className="row__actions">
        <button className="btn btn--primary btn--small">{q ? "Save" : "Add question"}</button>
        <button type="button" className="btn btn--ghost btn--small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Choosing facts for "Who wrote this?"

function FactPicker({ activity: a, view, run, players }: Props) {
  const chosen = view.polls[a.id] ?? [];
  const facts = useFacts(view);
  const used = new Set(chosen.map((q) => q.factId));
  const revealed = new Set(view.revealedQuestions[a.id] ?? []);
  const all = [...facts.entries()];

  return (
    <div className="qbank pollbank">
      <h4 className="callout__title">In this round, in order</h4>
      {chosen.length ? (
        <ol className="qlist">
          {chosen.map((q, i) => {
            const f = q.factId ? facts.get(q.factId) : undefined;
            const p = f ? players.get(f.playerId) : undefined;
            return (
              <li key={q.id} className="qlist__row">
                <span className="qlist__num">{i + 1}</span>
                <span className="qlist__prompt">
                  {f ? `“${f.text}”` : "(fact removed by its writer)"} <span className="host__muted">· {p?.name ?? "?"}</span>
                </span>
                <span className="row__actions">
                  <button className="btn btn--small btn--ghost" disabled={i === 0} onClick={() => run("poll.question.move", { activityId: a.id, questionId: q.id, direction: "up" })} aria-label="Move up">
                    ↑
                  </button>
                  <button
                    className="btn btn--small btn--ghost"
                    disabled={i === chosen.length - 1}
                    onClick={() => run("poll.question.move", { activityId: a.id, questionId: q.id, direction: "down" })}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn--small btn--ghost"
                    disabled={revealed.has(q.id) && view.ledger.some((e) => e.questionId === q.id && !e.voided)}
                    onClick={() => run("poll.question.delete", { activityId: a.id, questionId: q.id })}
                  >
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="host__muted">No facts chosen yet. Pick some below.</p>
      )}

      <h4 className="callout__title">Everyone's secret facts</h4>
      {all.length ? (
        <ul className="plain-list fact-pool">
          {all.map(([id, f]) => {
            const p = players.get(f.playerId);
            return (
              <li key={id} className="row">
                <span className="fact-pool__text">
                  {p && <Avatar player={p} />} <span>“{f.text}”</span> <span className="host__muted">· {p?.name}</span>
                </span>
                <button
                  className="btn btn--small btn--secondary"
                  disabled={used.has(id)}
                  onClick={() => run("poll.question.save", { activityId: a.id, question: { factId: id } })}
                >
                  {used.has(id) ? "Added" : "Add"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="host__muted">No secret facts yet. They come from the guest questionnaire.</p>
      )}
    </div>
  );
}
