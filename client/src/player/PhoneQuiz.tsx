// The quiz on a guest's phone: answer buttons, a shared team answer, and the result.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ANSWER_MAX, OPTION_LETTERS, formatNumber, imageUrl, signed, type PlayerView } from "../../../shared/types";
import { useTicker } from "../net";
import { formatClock } from "../ui";

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

export function PhoneQuiz({ view, send, serverNow }: { view: PlayerView; send: Send; serverNow: () => number }) {
  const qz = view.quiz;
  const a = qz ? view.activities.find((x) => x.id === qz.activityId) : undefined;
  const q = qz?.question ?? null;
  const open = qz?.phase === "open";
  useTicker(250, open && !!qz?.endsAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  // New question: clear the form and buzz.
  const lastQ = useRef<string | null>(null);
  useEffect(() => {
    if (q && q.id !== lastQ.current && qz?.phase === "open") navigator.vibrate?.(120);
    if (q?.id !== lastQ.current) {
      setTyped("");
      setError(null);
      setPending(null);
    }
    lastQ.current = q?.id ?? null;
  }, [q, qz?.phase]);

  if (!qz || !a) return null;
  const me = view.me!;
  const team = qz.kind === "team";
  const mine = view.myQuizAnswer;
  const partnerName = (id: string) => (id === me.id ? "you" : (view.players.find((p) => p.id === id)?.name ?? "your teammate"));

  const answer = async (value: string | number) => {
    if (!q) return;
    setError(null);
    setPending(String(value));
    try {
      await send("quiz.answer", { questionId: q.id, value });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  if (qz.phase === "intro" || !q) {
    return (
      <article className="now-playing quiz-phone">
        <span className="now-playing__kicker">Quiz time</span>
        <h2 className="now-playing__name">{a.name}</h2>
        <p className="now-playing__who">
          {team ? "One answer per team: either of you can answer, and the last answer in counts." : "Answer on your own phone. Every right answer scores for your team."}
        </p>
        <p>The questions appear on the TV. Your answer buttons appear here.</p>
      </article>
    );
  }

  const left = qz.endsAt ? qz.endsAt - serverNow() : null;
  const choices = q.type === "choice" || q.type === "truefalse";
  const shown = (v: string) => (choices ? `${q.type === "choice" ? `${OPTION_LETTERS[Number(v)]}: ` : ""}${q.options[Number(v)] ?? ""}` : q.type === "number" ? formatNumber(Number(v)) : v);
  const myId = team ? me.teamId : me.id;
  const result = qz.reveal?.results.find((r) => r.answererId === myId);

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim()) answer(typed.trim());
  };

  return (
    <article className={`now-playing quiz-phone quiz-phone--${qz.phase}`}>
      <div className="now-playing__head">
        <span className="now-playing__kicker">
          Question {q.number} of {qz.total}
        </span>
        <span className="naming__clock">{open ? (left !== null ? formatClock(left) : "") : qz.phase === "closed" ? "Closed" : ""}</span>
      </div>
      <p className="quiz-phone__prompt">{q.prompt}</p>
      {q.imageId && <img className="quiz-phone__image" src={imageUrl(q.imageId, view.eventCode)} alt="" />}

      {qz.phase === "revealed" ? (
        <div className={`quiz-phone__result ${result?.correct ? "is-right" : "is-wrong"}`} role="status">
          <p className="quiz-phone__verdict">{result?.correct ? `Right! ${signed(result.points)}${result.fastest ? " ⚡ fastest" : ""}` : mine ? "Not this time" : "No answer"}</p>
          <p>
            The answer: <strong>{qz.reveal!.answer}</strong>
          </p>
          {mine && !result?.correct && <p className="phone__muted">{team ? "Your team" : "You"} said {shown(mine.value)}.</p>}
        </div>
      ) : choices ? (
        <div className={`quiz-phone__options quiz-phone__options--${q.options.length}`}>
          {q.options.map((o, i) => {
            const chosen = mine?.value === String(i);
            return (
              <button
                key={i}
                className={`quiz-phone__option${chosen ? " is-chosen" : ""}${pending === String(i) ? " is-pending" : ""}`}
                disabled={!open}
                aria-pressed={chosen}
                onClick={() => answer(i)}
              >
                {q.type === "choice" && <span className="quiz-phone__letter">{OPTION_LETTERS[i]}</span>}
                <span>{o}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <form className="quiz-phone__typed" onSubmit={submitTyped}>
          <input
            className="input"
            inputMode={q.type === "number" ? "decimal" : "text"}
            autoComplete="off"
            autoCapitalize={q.type === "text" ? "sentences" : "off"}
            maxLength={ANSWER_MAX}
            placeholder={q.type === "number" ? "Your number" : "Your answer"}
            value={typed}
            disabled={!open}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Your answer"
          />
          <button className="btn btn--primary" disabled={!open || !typed.trim() || pending !== null}>
            {mine ? "Change answer" : "Lock in"}
          </button>
        </form>
      )}

      {qz.phase !== "revealed" && (
        <p className="quiz-phone__mine" aria-live="polite">
          {mine
            ? `${team ? "Your team's answer" : "Your answer"}: ${shown(mine.value)}${team ? ` (from ${partnerName(mine.byPlayerId)})` : ""}${open ? ". You can change it until time's up." : "."}`
            : open
              ? team
                ? "No answer from your team yet."
                : "Tap your answer."
              : `Answers are closed. ${team ? "Your team" : "You"} didn't answer.`}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
