// The quiz in the control room: running it (presenter view) and writing it
// (question editor and spreadsheet import).

import { useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ANSWER_MAX,
  MAX_MASH_GUESTS,
  MAX_OPTIONS,
  OPTION_LETTERS,
  OPTION_MAX,
  QUESTION_MAX,
  QUESTION_TYPE_LABEL,
  ROUND_QUESTIONS,
  VOTE_TYPES,
  answerText,
  formatNumber,
  imageUrl,
  teamDisplayName,
  type ActivityView,
  type HostPlayer,
  type HostQuizAnswer,
  type HostView,
  type PollOptionsKind,
  type QuestionType,
  type QuestionView,
} from "../../../shared/types";
import { uploadQuizImage } from "../image";
import { useTicker } from "../net";
import { EventCodeContext, formatClock, teamStyle } from "../ui";
import type { Run } from "./Scoring";

interface Props {
  activity: ActivityView;
  view: HostView;
  run: Run;
  players: Map<string, HostPlayer>;
  serverNow: () => number;
}

export function quizSummary(a: ActivityView): string {
  const parts = [
    a.kind === "team" ? "Teams answer together" : "Everyone answers for their team",
    `${a.perCorrect} ${a.perCorrect === 1 ? "point" : "points"} per correct answer`,
    a.questionSeconds ? `${a.questionSeconds} seconds per question` : "no timer",
  ];
  if (a.speedBonus) parts.push(`+${a.speedBonus} for the fastest correct answer`);
  return parts.join(" · ");
}

export function QuizPad({ activity: a, view, run, players, serverNow }: Props) {
  const questions = view.questions[a.id] ?? [];
  const [tab, setTab] = useState<"run" | "questions">(questions.length ? "run" : "questions");
  return (
    <div className="quiz-pad">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "run"} className={`tabs__tab${tab === "run" ? " is-selected" : ""}`} onClick={() => setTab("run")}>
          Run the quiz
        </button>
        <button role="tab" aria-selected={tab === "questions"} className={`tabs__tab${tab === "questions" ? " is-selected" : ""}`} onClick={() => setTab("questions")}>
          Questions ({questions.length}
          {view.runSheet.includes(a.id) ? ` of ${ROUND_QUESTIONS}` : ""})
        </button>
      </div>
      {tab === "run" ? (
        <Presenter activity={a} view={view} run={run} players={players} serverNow={serverNow} onEdit={() => setTab("questions")} />
      ) : (
        <QuestionBank activity={a} view={view} run={run} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presenter view

function Presenter({ activity: a, view, run, players, serverNow, onEdit }: Props & { onEdit: () => void }) {
  const questions = view.questions[a.id] ?? [];
  const revealed = new Set(view.revealedQuestions[a.id] ?? []);
  const live = view.quiz && view.quiz.activityId === a.id ? view.quiz : null;
  const q = live && live.index >= 0 ? questions[live.index] : undefined;
  const next = live ? questions[live.index + 1] : questions.find((x) => !revealed.has(x.id));
  useTicker(250, live?.phase === "open");

  if (!questions.length) {
    return (
      <div className="callout">
        <p>This quiz has no questions yet.</p>
        <button className="btn btn--small btn--secondary" onClick={onEdit}>
          Add questions
        </button>
      </div>
    );
  }

  if (!live) {
    const played = questions.filter((x) => revealed.has(x.id)).length;
    return (
      <div className="presenter">
        <p className="host__muted">
          {questions.length} questions{played ? `, ${played} played so far` : ""}.
        </p>
        <button className="btn btn--primary" disabled={view.draw.phase !== "complete"} onClick={() => run("quiz.start", { activityId: a.id })}>
          {played ? "Put the quiz back on the TV" : "Start the quiz on the TV"}
        </button>
        {view.draw.phase !== "complete" && <p className="host__muted">You can start it once the teams are drawn.</p>}
      </div>
    );
  }

  const total = view.draw.phase === "complete" ? (a.kind === "team" ? view.teams.length : view.teams.reduce((n, t) => n + t.memberIds.length, 0)) : 0;
  const left = live.endsAt ? live.endsAt - serverNow() : null;

  return (
    <div className="presenter">
      {live.phase === "intro" || !q ? (
        <div className="presenter__card">
          <p className="presenter__meta">The TV shows the round's title. Open the first question when everyone's ready.</p>
          {next && <NextUp q={next} number={live.index + 2} />}
        </div>
      ) : (
        <div className="presenter__card">
          <div className="presenter__meta">
            <span>
              Question {live.index + 1} of {questions.length} · {QUESTION_TYPE_LABEL[q.type]}
            </span>
            <span className={`phase phase--${live.phase}`}>
              {live.phase === "open" ? (left !== null ? `Open · ${formatClock(left)}` : "Open · no timer") : live.phase === "closed" ? "Answers closed" : "Answer revealed"}
            </span>
          </div>
          <QuestionBody q={q} view={view} showAnswer />
          {q.videoId && (
            <button className="btn btn--small btn--secondary" onClick={() => run("video.play", { videoId: q.videoId, activityId: a.id }, "Playing the clip on the TV")}>
              ▶ Play the clip again
            </button>
          )}
          {(q.notes || q.fact) && (
            <div className="presenter__notes">
              {q.notes && (
                <p>
                  <strong>Your notes:</strong> {q.notes}
                </p>
              )}
              {q.fact && (
                <p>
                  <strong>Fun fact to share:</strong> {q.fact}
                </p>
              )}
            </div>
          )}
          <div className="presenter__actions">
            {live.phase === "open" && (
              <button className="btn btn--secondary" onClick={() => run("quiz.close")}>
                Close answers now
              </button>
            )}
            {live.phase === "closed" && (
              <>
                <button className="btn btn--primary" onClick={() => run("quiz.reveal")}>
                  Reveal the answer
                </button>
                <button className="btn btn--ghost" onClick={() => run("quiz.reopen", { seconds: 15 })}>
                  Reopen for 15 seconds
                </button>
              </>
            )}
          </div>
          <Answers view={view} activity={a} q={q} players={players} total={total} run={run} phase={live.phase} />
        </div>
      )}

      {live.phase === "revealed" && q && (
        <div className="presenter__actions">
          {next ? (
            <button className="btn btn--primary" onClick={() => run("quiz.open")}>
              Open question {live.index + 2}
            </button>
          ) : (
            <button className="btn btn--primary" onClick={() => run("results.show", { activityId: a.id })}>
              Show the round results on the TV
            </button>
          )}
        </div>
      )}
      {live.phase === "revealed" && next && <NextUp q={next} number={live.index + 2} />}

      <details className="presenter__list">
        <summary>All questions</summary>
        <ol className="qlist">
          {questions.map((x, i) => (
            <li key={x.id} className={`qlist__row${live.index === i ? " is-current" : ""}`}>
              <span className="qlist__num">{i + 1}</span>
              <span className="qlist__prompt">{x.prompt}</span>
              <span className="host__muted">{revealed.has(x.id) ? "played" : ""}</span>
              <button
                className="btn btn--small btn--ghost"
                disabled={live.phase === "open"}
                onClick={() => {
                  if (revealed.has(x.id) && !confirm(`Play question ${i + 1} again? Its answers and points will be cleared.`)) return;
                  run("quiz.open", { index: i });
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

function NextUp({ q, number }: { q: QuestionView; number: number }) {
  return (
    <div className="next-up">
      <p className="host__muted">Next: question {number}</p>
      <p className="next-up__prompt">{q.type === "whowrote" ? "Who wrote this? (a secret fact)" : q.prompt}</p>
      <p className="host__muted">Answer: {answerText(q)}</p>
    </div>
  );
}

/** A guest's secret fact and who wrote it, for "Who wrote this?" questions. */
export function factLookup(view: HostView, factId: string | null) {
  if (!factId) return null;
  for (const [playerId, qn] of Object.entries(view.questionnaires)) {
    const f = qn.facts.find((x) => x.id === factId);
    if (f) return { text: f.text, writer: view.roster.find((p) => p.id === playerId)?.name ?? "A guest" };
  }
  return null;
}

const POLL_KIND_LABEL: Record<PollOptionsKind, string> = { custom: "Your own options", players: "A guest", teams: "A team" };

function QuestionBody({ q, view, showAnswer }: { q: QuestionView; view: HostView; showAnswer?: boolean }) {
  const code = useContext(EventCodeContext);
  const fact = q.type === "whowrote" ? factLookup(view, q.factId) : null;
  const videoName = q.videoId ? view.videos.find((v) => v.id === q.videoId)?.name : null;
  return (
    <div className="qbody">
      {q.imageId && <img className="qbody__image" src={imageUrl(q.imageId, code)} alt="" />}
      <div className="qbody__text">
        {videoName && <p className="host__muted">🎬 Plays first on the TV: {videoName}</p>}
        <p className="qbody__prompt">{q.type === "whowrote" ? `“${fact?.text ?? "(this fact has been removed)"}”` : q.prompt}</p>
        {q.type === "whowrote" && showAnswer && fact && (
          <p className="qbody__answer">
            Written by <strong>{fact.writer}</strong>. Their team can't score on this one.
          </p>
        )}
        {q.type === "facemash" && showAnswer && (
          <p className="qbody__answer">
            In it: <strong>{[...q.pickNames, ...(q.accepted[0] ? [q.accepted[0]] : [])].join(" + ")}</strong>
            {q.bonus ? ` · +${q.bonus} for all of them` : ""}
          </p>
        )}
        {q.type === "poll" && (
          <>
            <p className="host__muted">Teams vote for: {POLL_KIND_LABEL[q.optionsKind]}. Teams that pick the most popular answer score.</p>
            {q.optionsKind === "custom" && (
              <ol className="qbody__options">
                {q.options.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ol>
            )}
          </>
        )}
        {(q.type === "choice" || q.type === "truefalse") && (
          <ol className="qbody__options">
            {q.options.map((o, i) => (
              <li key={i} className={showAnswer && i === q.correctIndex ? "is-correct" : ""}>
                <span className="qbody__letter">{q.type === "choice" ? OPTION_LETTERS[i] : ""}</span> {o}
              </li>
            ))}
          </ol>
        )}
        {showAnswer && (q.type === "number" || q.type === "text") && (
          <p className="qbody__answer">
            Answer: <strong>{q.type === "number" ? formatNumber(q.numberAnswer ?? 0) : q.accepted.join(" / ")}</strong>
          </p>
        )}
      </div>
    </div>
  );
}

function Answers({
  view,
  activity: a,
  q,
  players,
  total,
  run,
  phase,
}: {
  view: HostView;
  activity: ActivityView;
  q: QuestionView;
  players: Map<string, HostPlayer>;
  total: number;
  run: Run;
  phase: string;
}) {
  const teams = new Map(view.teams.map((t) => [t.id, t]));
  const answers = view.quizAnswers;
  const name = (ans: HostQuizAnswer) => {
    if (a.kind === "team") {
      const t = teams.get(ans.answererId);
      return t ? teamDisplayName(t) : "A team";
    }
    return players.get(ans.answererId)?.name ?? "A guest";
  };
  const choices = view.quiz?.question?.choices ?? [];
  const mashShown = (ans: HostQuizAnswer) => {
    try {
      const v = JSON.parse(ans.value) as { guests: string[]; celebrity: string };
      const names = v.guests;
      return [...names, ...(v.celebrity ? [`“${v.celebrity}”`] : [])].join(" + ");
    } catch {
      return ans.value;
    }
  };
  const shown = (ans: HostQuizAnswer) =>
    q.type === "facemash"
      ? `${mashShown(ans)}${ans.detail ? ` (${ans.detail}${ans.points ? `, ${ans.points} pts` : ""})` : ""}`
      : VOTE_TYPES.includes(q.type)
      ? (choices.find((c) => c.key === ans.value)?.label ?? "?")
      : q.type === "choice" || q.type === "truefalse"
        ? `${q.type === "choice" ? `${OPTION_LETTERS[Number(ans.value)]}: ` : ""}${q.options[Number(ans.value)] ?? "?"}`
        : q.type === "number"
          ? formatNumber(Number(ans.value))
          : ans.value;
  const toReview = answers.filter((x) => x.auto === "close" && x.override === null).length;

  return (
    <div className="answers">
      <p className="answers__count">
        {answers.length} of {total} {a.kind === "team" ? "teams" : "players"} answered
        {toReview > 0 && <span className="tag tag--warn">{toReview} to check</span>}
      </p>
      {answers.length > 0 && (
        <ul className="answers__list">
          {answers.map((ans) => {
            const team = a.kind === "team" ? teams.get(ans.answererId) : teams.get(players.get(ans.answererId)?.teamId ?? "");
            return (
              <li key={ans.answererId} className={`answers__row answers__row--${ans.correct ? "right" : ans.auto === "close" && ans.override === null ? "close" : "wrong"}`} style={team ? teamStyle(team) : undefined}>
                <span className="answers__who">{name(ans)}</span>
                <span className={`answers__value${q.type === "facemash" ? " answers__value--long" : ""}`}>{phase === "open" && q.type !== "text" && q.type !== "number" && q.type !== "facemash" ? "Answered" : shown(ans)}</span>
                <span className="answers__mark">
                  {q.type === "facemash"
                    ? ans.override !== null
                      ? `Celebrity marked ${ans.override ? "right" : "wrong"}`
                      : ans.auto === "close"
                        ? "Celebrity close: check it"
                        : ans.auto === "correct"
                          ? "All right"
                          : ""
                    : ans.override !== null
                      ? ans.override
                        ? "Marked right"
                        : "Marked wrong"
                      : ans.auto === "correct"
                        ? "Right"
                        : ans.auto === "close"
                          ? "Close: check it"
                          : "Wrong"}
                </span>
                <span className="answers__buttons">
                  <button className="btn btn--small btn--ghost" aria-pressed={ans.override === true} onClick={() => run("quiz.mark", { answererId: ans.answererId, correct: true })} aria-label={q.type === "facemash" ? `Mark ${name(ans)}'s celebrity right` : `Mark ${name(ans)} right`}>
                    ✓
                  </button>
                  <button className="btn btn--small btn--ghost" aria-pressed={ans.override === false} onClick={() => run("quiz.mark", { answererId: ans.answererId, correct: false })} aria-label={q.type === "facemash" ? `Mark ${name(ans)}'s celebrity wrong` : `Mark ${name(ans)} wrong`}>
                    ✗
                  </button>
                  {ans.override !== null && (
                    <button className="btn btn--small btn--ghost" onClick={() => run("quiz.mark", { answererId: ans.answererId, correct: null })}>
                      Auto
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Writing the quiz

function QuestionBank({ activity: a, view, run }: { activity: ActivityView; view: HostView; run: Run }) {
  const questions = view.questions[a.id] ?? [];
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const onTv = view.stage.screen === "quiz" && view.quiz?.activityId === a.id;

  if (editing) {
    const q = editing === "new" ? undefined : questions.find((x) => x.id === editing);
    return <QuestionForm activity={a} view={view} question={q} number={q ? questions.indexOf(q) + 1 : questions.length + 1} run={run} onDone={() => setEditing(null)} />;
  }
  if (importing) return <ImportForm activity={a} run={run} onDone={() => setImporting(false)} />;

  return (
    <div className="bank">
      <div className="bank__actions">
        <button className="btn btn--primary btn--small" onClick={() => setEditing("new")}>
          Add a question
        </button>
        <button className="btn btn--secondary btn--small" onClick={() => setImporting(true)}>
          Paste from a spreadsheet
        </button>
      </div>
      {view.runSheet.includes(a.id) && (
        <p className={`host__muted bank__count${questions.length === ROUND_QUESTIONS ? " is-full" : ""}`}>
          {questions.length} of {ROUND_QUESTIONS} questions written
          {questions.length > ROUND_QUESTIONS ? ` (${questions.length - ROUND_QUESTIONS} more than planned)` : ""}
        </p>
      )}
      {questions.length === 0 ? (
        <p className="host__muted">No questions yet. Guests never see them until you open each one during the game.</p>
      ) : (
        <ol className="qlist">
          {questions.map((q, i) => (
            <li key={q.id} className="qlist__row">
              <span className="qlist__num">{i + 1}</span>
              <span className="qlist__prompt">
                {q.type === "whowrote" ? `“${factLookup(view, q.factId)?.text ?? "(fact removed)"}”` : q.prompt}
                <span className="host__muted qlist__detail">
                  {QUESTION_TYPE_LABEL[q.type]} ·{" "}
                  {q.type === "whowrote"
                    ? `written by ${factLookup(view, q.factId)?.writer ?? "?"}`
                    : q.type === "facemash"
                      ? [...q.pickNames, ...(q.accepted[0] ? [q.accepted[0]] : [])].join(" + ")
                      : answerText(q)}
                  {q.imageId ? " · photo" : ""}
                  {q.videoId ? " · video" : ""}
                </span>
              </span>
              <span className="qlist__tools">
                <button className="btn btn--small btn--ghost" disabled={i === 0 || onTv} onClick={() => run("quiz.question.move", { activityId: a.id, questionId: q.id, direction: "up" })} aria-label="Move up">
                  ↑
                </button>
                <button className="btn btn--small btn--ghost" disabled={i === questions.length - 1 || onTv} onClick={() => run("quiz.question.move", { activityId: a.id, questionId: q.id, direction: "down" })} aria-label="Move down">
                  ↓
                </button>
                <button className="btn btn--small btn--ghost" onClick={() => setEditing(q.id)}>
                  Edit
                </button>
                <button
                  className="btn btn--small btn--ghost"
                  onClick={() => {
                    if (confirm(`Delete question ${i + 1}?`)) run("quiz.question.delete", { activityId: a.id, questionId: q.id });
                  }}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function QuestionForm({
  activity: a,
  view,
  question,
  number,
  run,
  onDone,
}: {
  activity: ActivityView;
  view: HostView;
  question?: QuestionView;
  number: number;
  run: Run;
  onDone: () => void;
}) {
  const code = useContext(EventCodeContext);
  const [type, setType] = useState<QuestionType>(question?.type ?? "choice");
  const [prompt, setPrompt] = useState(question?.type === "whowrote" ? "" : (question?.prompt ?? ""));
  const [options, setOptions] = useState<string[]>(question?.type === "choice" || question?.type === "poll" ? question.options : ["", "", "", ""]);
  const [optionsKind, setOptionsKind] = useState<PollOptionsKind>(question?.optionsKind ?? "custom");
  const [factId, setFactId] = useState<string>(question?.factId ?? "");
  const [videoId, setVideoId] = useState<string>(question?.videoId ?? "");
  const [pickNames, setPickNames] = useState<string[]>(question?.pickNames ?? []);
  const [bonus, setBonus] = useState(question?.bonus != null ? String(question.bonus) : "2");
  const [answerImageId, setAnswerImageId] = useState<string | null>(question?.answerImageId ?? null);
  const answerFile = useRef<HTMLInputElement>(null);
  const [correct, setCorrect] = useState(question?.correctIndex ?? 0);
  const [numberAnswer, setNumberAnswer] = useState(question?.numberAnswer !== null && question?.numberAnswer !== undefined ? String(question.numberAnswer) : "");
  const [accepted, setAccepted] = useState((question?.accepted ?? []).join("\n"));
  const [imageId, setImageId] = useState<string | null>(question?.imageId ?? null);
  const [points, setPoints] = useState(question?.points != null ? String(question.points) : "");
  const [seconds, setSeconds] = useState(question?.seconds != null ? String(question.seconds) : "");
  const [notes, setNotes] = useState(question?.notes ?? "");
  const [fact, setFact] = useState(question?.fact ?? "");
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const upload = async (f: File | undefined, set: (id: string) => void = setImageId) => {
    if (!f) return;
    setBusy(true);
    setUploadError(null);
    try {
      set(await uploadQuizImage(f));
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
      if (answerFile.current) answerFile.current.value = "";
    }
  };

  const submit = async (e: FormEvent, another: boolean) => {
    e.preventDefault();
    setBusy(true);
    const filled = options.map((o) => o.trim());
    const kept = filled.filter(Boolean);
    const correctText = filled[correct];
    const res = await run(
      "quiz.question.save",
      {
        activityId: a.id,
        questionId: question?.id,
        question: {
          type,
          prompt,
          options: kept,
          correctIndex: type === "choice" ? Math.max(0, kept.indexOf(correctText)) : correct,
          numberAnswer,
          accepted: accepted.split("\n"),
          imageId,
          videoId: videoId || null,
          optionsKind,
          factId: factId || null,
          pickNames,
          bonus: bonus === "" ? null : Number(bonus),
          answerImageId,
          points: points === "" ? null : Number(points),
          seconds: seconds === "" ? null : Number(seconds),
          notes,
          fact,
        },
      },
      question ? "Question saved" : "Question added",
    );
    setBusy(false);
    if (res === undefined) return;
    if (another && !question) {
      setPrompt("");
      setOptions(["", "", "", ""]);
      setCorrect(0);
      setNumberAnswer("");
      setAccepted("");
      setImageId(null);
      setVideoId("");
      setFactId("");
      setPickNames([]);
      setAnswerImageId(null);
      setNotes("");
      setFact("");
    } else onDone();
  };

  return (
    <form className="qform" onSubmit={(e) => submit(e, false)}>
      <h4 className="qform__title">{question ? `Edit question ${number}` : `New question ${number}`}</h4>
      <div className="segmented" role="radiogroup" aria-label="Question type">
        {(Object.keys(QUESTION_TYPE_LABEL) as QuestionType[]).map((t) => (
          <button
            type="button"
            key={t}
            role="radio"
            aria-checked={type === t}
            className={type === t ? "is-selected" : ""}
            onClick={() => {
              setType(t);
              if (t === "truefalse" && correct > 1) setCorrect(0);
            }}
          >
            {QUESTION_TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      {type === "whowrote" ? (
        <FactPicker view={view} factId={factId} setFactId={setFactId} currentQuestionId={question?.id} />
      ) : (
        <label className="field">
          <span className="field__label">Question</span>
          <textarea
            className="input input--area"
            rows={2}
            maxLength={QUESTION_MAX}
            value={prompt}
            placeholder={type === "facemash" ? "Who's in this face mash?" : undefined}
            onChange={(e) => setPrompt(e.target.value)}
            required={type !== "facemash"}
            autoFocus
          />
        </label>
      )}

      {type === "poll" && (
        <fieldset className="choice">
          <legend className="choice__legend">Teams vote for</legend>
          <div className="segmented" role="radiogroup" aria-label="Teams vote for">
            {(Object.keys(POLL_KIND_LABEL) as PollOptionsKind[]).map((k) => (
              <button type="button" key={k} role="radio" aria-checked={optionsKind === k} className={optionsKind === k ? "is-selected" : ""} onClick={() => setOptionsKind(k)}>
                {POLL_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {optionsKind === "custom" &&
            options.map((o, i) => (
              <div key={i} className="qform__option qform__option--plain">
                <span className="qbody__letter">{OPTION_LETTERS[i]}</span>
                <input className="input input--small" value={o} maxLength={OPTION_MAX} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
                {options.length > 2 && (
                  <button type="button" className="btn btn--small btn--ghost" aria-label={`Remove option ${OPTION_LETTERS[i]}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          {optionsKind === "custom" && options.length < MAX_OPTIONS && (
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setOptions([...options, ""])}>
              Add an option
            </button>
          )}
          <p className="host__muted">
            {optionsKind === "players"
              ? "Every guest's photo and name appear as the choices."
              : optionsKind === "teams"
                ? "Every team appears as a choice; a team can't vote for itself."
                : "Write the choices teams pick between."}{" "}
            Teams that pick the most popular answer score.
          </p>
        </fieldset>
      )}

      {type === "choice" && (
        <fieldset className="choice">
          <legend className="choice__legend">Options (select the right one)</legend>
          {options.map((o, i) => (
            <div key={i} className="qform__option">
              <input type="radio" name="correct" checked={correct === i} onChange={() => setCorrect(i)} aria-label={`Option ${OPTION_LETTERS[i]} is right`} />
              <span className="qbody__letter">{OPTION_LETTERS[i]}</span>
              <input className="input input--small" value={o} maxLength={OPTION_MAX} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
              {options.length > 2 && (
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  aria-label={`Remove option ${OPTION_LETTERS[i]}`}
                  onClick={() => {
                    setOptions(options.filter((_, j) => j !== i));
                    if (correct >= i && correct > 0) setCorrect(correct - 1);
                  }}
                >
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
        </fieldset>
      )}
      {type === "truefalse" && (
        <div className="segmented" role="radiogroup" aria-label="The right answer">
          <button type="button" role="radio" aria-checked={correct === 0} className={correct === 0 ? "is-selected" : ""} onClick={() => setCorrect(0)}>
            True
          </button>
          <button type="button" role="radio" aria-checked={correct === 1} className={correct === 1 ? "is-selected" : ""} onClick={() => setCorrect(1)}>
            False
          </button>
        </div>
      )}
      {type === "number" && (
        <label className="field field--inline">
          <span className="field__label">Right answer (the closest guess wins)</span>
          <input className="input input--small" inputMode="decimal" value={numberAnswer} onChange={(e) => setNumberAnswer(e.target.value)} required />
        </label>
      )}
      {type === "text" && (
        <label className="field">
          <span className="field__label">Accepted answers, one per line</span>
          <textarea className="input input--area" rows={3} maxLength={ANSWER_MAX * 6} value={accepted} onChange={(e) => setAccepted(e.target.value)} required />
          <span className="host__muted">Case, punctuation and a leading "the" don't matter. Near misses come to you to check.</span>
        </label>
      )}

      {type === "facemash" && (
        <fieldset className="choice">
          <legend className="choice__legend">Who's in the mash (up to {MAX_MASH_GUESTS})</legend>
          <div className="mash-pick">
            {view.mashNames.map((n) => {
              const on = pickNames.includes(n);
              return (
                <label key={n} className={`mash-pick__guest${on ? " is-on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && pickNames.length >= MAX_MASH_GUESTS}
                    onChange={() => setPickNames(on ? pickNames.filter((x) => x !== n) : [...pickNames, n])}
                  />
                  {n}
                </label>
              );
            })}
          </div>
          <MashNamesEditor view={view} run={run} />
          <label className="field">
            <span className="field__label">A celebrity too? Type them, with other spellings to accept, one per line (leave empty for none)</span>
            <textarea className="input input--area" rows={2} maxLength={ANSWER_MAX * 6} value={accepted} onChange={(e) => setAccepted(e.target.value)} />
            <span className="host__muted">Teams tick the names from the list, in any order. A point for each one right, plus the bonus for all of them.</span>
          </label>
          <label className="field field--inline">
            <span className="field__label">Bonus for getting everyone right</span>
            <input className="input input--small input--num" type="number" min={0} value={bonus} onChange={(e) => setBonus(e.target.value)} />
          </label>
          <div className="qform__picture">
            {answerImageId ? (
              <>
                <img src={imageUrl(answerImageId, code)} alt="" />
                <button type="button" className="btn btn--small btn--ghost" onClick={() => setAnswerImageId(null)}>
                  Remove the answer photo
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={() => answerFile.current?.click()}>
                {busy ? "Uploading…" : "Add an answer photo (shown at the reveal, e.g. the originals)"}
              </button>
            )}
            <input ref={answerFile} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0], setAnswerImageId)} />
          </div>
        </fieldset>
      )}

      <div className="qform__picture">
        {imageId ? (
          <>
            <img src={imageUrl(imageId, code)} alt="" />
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setImageId(null)}>
              Remove the photo
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? "Uploading…" : type === "facemash" ? "Add the face mash photo" : "Add a photo (shown on the TV and phones)"}
          </button>
        )}
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
        {uploadError && <p className="form-error">{uploadError}</p>}
      </div>
      <label className="field field--inline video-pick">
        <span className="field__label">Video clip (plays on the TV when the question opens; the timer starts after it)</span>
        <select className="input input--small" value={videoId} onChange={(e) => setVideoId(e.target.value)}>
          <option value="">None</option>
          {view.videos.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        {!view.videos.length && <span className="host__muted">Upload clips in the Videos panel at the bottom of the page.</span>}
      </label>

      <div className="qform__row">
        <label className="field field--inline">
          <span className="field__label">Points</span>
          <input className="input input--small input--num" type="number" min={0} value={points} placeholder={String(a.perCorrect)} onChange={(e) => setPoints(e.target.value)} />
        </label>
        <label className="field field--inline">
          <span className="field__label">Seconds (0 for no timer)</span>
          <input className="input input--small input--num" type="number" min={0} value={seconds} placeholder={String(a.questionSeconds)} onChange={(e) => setSeconds(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="field__label">Notes for you (optional, never shown to guests)</span>
        <input className="input" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Fun fact to read out after the answer (optional)</span>
        <input className="input" value={fact} maxLength={500} onChange={(e) => setFact(e.target.value)} />
      </label>
      <div className="activity-form__actions">
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          Cancel
        </button>
        {!question && (
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={(e) => submit(e as unknown as FormEvent, true)}>
            Save and add another
          </button>
        )}
        <button className="btn btn--primary" disabled={busy}>
          {question ? "Save question" : "Save question"}
        </button>
      </div>
    </form>
  );
}

/** The names teams pick from in face mash questions, shared by every face mash. */
function MashNamesEditor({ view, run }: { view: HostView; run: Run }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(view.mashNames.join("\n"));
  if (!open) {
    return (
      <button
        type="button"
        className="btn btn--small btn--ghost"
        onClick={() => {
          setText(view.mashNames.join("\n"));
          setOpen(true);
        }}
      >
        Edit the names list (used by every face mash)
      </button>
    );
  }
  return (
    <div className="field">
      <span className="field__label">Names teams pick from, one per line</span>
      <textarea className="input input--area" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row__actions">
        <button
          type="button"
          className="btn btn--small btn--secondary"
          onClick={async () => {
            if (await run("quiz.mashNames", { names: text.split("\n") }, "Names list saved")) setOpen(false);
          }}
        >
          Save the names
        </button>
        <button type="button" className="btn btn--small btn--ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Picks a guest's secret fact for a "Who wrote this?" question. */
function FactPicker({
  view,
  factId,
  setFactId,
  currentQuestionId,
}: {
  view: HostView;
  factId: string;
  setFactId: (id: string) => void;
  currentQuestionId?: string;
}) {
  const used = new Set(
    view.activities
      .flatMap((x) => view.questions[x.id] ?? [])
      .filter((q) => q.type === "whowrote" && q.id !== currentQuestionId)
      .map((q) => q.factId),
  );
  // The hosts (the House) can't be guessed, so only players' facts.
  const facts = view.roster.filter((p) => !p.house).flatMap((p) => (view.questionnaires[p.id]?.facts ?? []).map((f) => ({ ...f, writer: p.name })));
  if (!facts.length) return <p className="callout">No secret facts yet. They come from the guests' questionnaires.</p>;
  return (
    <label className="field">
      <span className="field__label">The secret fact (only you can see who wrote it)</span>
      <select className="input" value={factId} onChange={(e) => setFactId(e.target.value)} required autoFocus>
        <option value="">Choose a fact…</option>
        {facts.map((f) => (
          <option key={f.id} value={f.id}>
            {f.writer}: {f.text}
            {used.has(f.id) ? " (already used)" : ""}
          </option>
        ))}
      </select>
      <span className="host__muted">The fact goes up on the TV and teams guess who wrote it. The writer's team can't score on it.</span>
    </label>
  );
}

const TEMPLATE =
  "Type,Question,Answer,Wrong answer 1,Wrong answer 2,Wrong answer 3,Wrong answer 4,Wrong answer 5,Seconds,Points,Notes,Fun fact\n";

function ImportForm({ activity: a, run, onDone }: { activity: ActivityView; run: Run; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const template = useMemo(() => URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" })), []);
  useEffect(() => () => URL.revokeObjectURL(template), [template]);

  return (
    <form
      className="qform"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await run<{ added: number }>("quiz.import", { activityId: a.id, text });
        setBusy(false);
        if (res) onDone();
      }}
    >
      <h4 className="qform__title">Paste questions from a spreadsheet</h4>
      <p>
        Copy the rows from Google Sheets or Excel (or paste a CSV file's contents) with these columns. Only Question and Answer are required.
      </p>
      <table className="import-help">
        <thead>
          <tr>
            <th>Type</th>
            <th>Question</th>
            <th>Answer</th>
            <th>Wrong answers 1–5</th>
            <th>Seconds</th>
            <th>Points</th>
            <th>Notes</th>
            <th>Fun fact</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>choice, truefalse, number, text or poll (or blank)</td>
            <td>The question</td>
            <td>The right answer. For typed answers, separate alternatives with |</td>
            <td>For multiple choice (shuffled); for a poll, the other choices</td>
            <td>Optional</td>
            <td>Optional</td>
            <td>Optional</td>
            <td>Optional</td>
          </tr>
        </tbody>
      </table>
      <p className="host__muted">
        A blank type is worked out for you: wrong answers make it multiple choice, True or False makes it true or false, a number makes it closest number, and anything
        else is a typed answer. A header row is skipped. <a href={template} download="friendsmas-quiz-template.csv">Download a template</a>
      </p>
      <textarea className="input input--area import-area" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste rows here" />
      <div className="activity-form__actions">
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy || !text.trim()}>
          Import questions
        </button>
      </div>
    </form>
  );
}
