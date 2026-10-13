// The quiz on the TV.

import { useEffect, useMemo, useRef } from "react";
import { OPTION_LETTERS, imageUrl, signed, teamDisplayName, type StageView } from "../../../shared/types";
import { audioOn, sfx } from "../audio";
import { useTicker } from "../net";
import { Avatar, formatClock, playerMap, teamStyle } from "../ui";

export function QuizStage({ view, serverNow }: { view: StageView; serverNow: () => number }) {
  const qz = view.quiz!;
  const a = view.activities.find((x) => x.id === qz.activityId);
  const q = qz.question;
  const open = qz.phase === "open";
  const now = useTicker(200, open && !!qz.endsAt);
  const left = qz.endsAt ? qz.endsAt - serverNow() : null;
  const players = useMemo(() => playerMap(view.players), [view.players]);

  // Countdown pips, the buzzer when answers close, and a chime on the reveal.
  const lastSec = useRef<number | null>(null);
  useEffect(() => {
    if (!open || left === null || !audioOn()) return;
    const sec = Math.ceil(left / 1000);
    if (sec !== lastSec.current && sec <= 5 && sec > 0) sfx.pip();
    lastSec.current = sec;
  }, [now, open, left]);
  const prevPhase = useRef(qz.phase);
  useEffect(() => {
    if (audioOn()) {
      if (prevPhase.current === "open" && qz.phase === "closed") sfx.buzzer();
      if (prevPhase.current !== "revealed" && qz.phase === "revealed") sfx.fanfare();
    }
    prevPhase.current = qz.phase;
  }, [qz.phase]);

  if (!a) return null;

  if (qz.phase === "intro" || !q) {
    return (
      <section className="scene quiz-intro">
        <p className="activity-intro__kind">Quiz · {qz.total} questions</p>
        <h1 className="activity-intro__name">{a.name}</h1>
        <p className="quiz-intro__how">
          📱 {a.kind === "team" ? "Answer on your phones: one answer per team, and the last one in counts." : "Answer on your own phone. Every right answer scores for your team."}
        </p>
        {a.speedBonus > 0 && <p className="quiz-intro__bonus">Fastest right answer: +{a.speedBonus} bonus</p>}
      </section>
    );
  }

  const revealed = qz.phase === "revealed" && qz.reveal;
  const results = new Map((qz.reveal?.results ?? []).map((r) => [r.answererId, r]));
  const answered = new Set(qz.answeredIds);
  const choices = q.type === "choice" || q.type === "truefalse";
  const correctIndex = revealed ? (qz.reveal!.correctIndex ?? -1) : -1;

  const answerers =
    qz.kind === "team"
      ? view.teams.map((t) => ({ id: t.id, team: t, label: `${t.badge} ${teamDisplayName(t)}`, player: null }))
      : view.teams.flatMap((t) =>
          t.memberIds.map((id) => ({ id, team: t, label: players.get(id)?.name ?? "", player: players.get(id) ?? null })),
        );

  return (
    <section className={`scene quiz-q${q.imageId ? " quiz-q--image" : ""}`}>
      <header className="quiz-q__head">
        <span className="quiz-q__num">
          Question {q.number} <span className="quiz-q__of">of {qz.total}</span>
        </span>
        <span className={`quiz-q__clock${open && left !== null && left <= 5000 ? " is-low" : ""}`}>
          {open ? (left !== null ? formatClock(left) : "") : qz.phase === "closed" ? "Answers are in" : ""}
        </span>
      </header>
      <div className="quiz-q__body">
        {q.imageId && <img className="quiz-q__image" src={imageUrl(q.imageId, view.eventCode)} alt="" />}
        <div className="quiz-q__main">
          <h1 className="quiz-q__prompt">{q.prompt}</h1>
          {choices ? (
            <ol className={`quiz-options quiz-options--${q.options.length}`}>
              {q.options.map((o, i) => (
                <li key={i} className={`quiz-option${revealed ? (i === correctIndex ? " is-correct" : " is-dim") : ""}`}>
                  {q.type === "choice" && <span className="quiz-option__letter">{OPTION_LETTERS[i]}</span>}
                  <span className="quiz-option__text">{o}</span>
                </li>
              ))}
            </ol>
          ) : revealed ? (
            <p className="quiz-q__answer">
              <span className="quiz-q__answer-label">{q.type === "number" ? "The answer (closest wins)" : "The answer"}</span>
              {qz.reveal!.answer}
            </p>
          ) : (
            <p className="quiz-q__type-hint">{q.type === "number" ? "Closest number wins. Enter it on your phone." : "Type your answer on your phone."}</p>
          )}
        </div>
      </div>
      <ul className={`quiz-status${qz.kind === "individual" ? " quiz-status--players" : ""}`}>
        {answerers.map((x) => {
          const r = results.get(x.id);
          const state = revealed ? (r?.correct ? "right" : "wrong") : answered.has(x.id) ? "in" : "waiting";
          return (
            <li key={x.id} className={`quiz-chip quiz-chip--${state}`} style={teamStyle(x.team)}>
              {x.player && <Avatar player={x.player} className="quiz-chip__avatar" />}
              <span className="quiz-chip__name">{x.label}</span>
              {revealed && r?.value && <span className="quiz-chip__value">{r.value}</span>}
              {revealed && <span className="quiz-chip__mark">{r?.correct ? `${signed(r.points)}${r.fastest ? " ⚡" : ""}` : "✗"}</span>}
              {!revealed && answered.has(x.id) && <span className="quiz-chip__mark">✓</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
