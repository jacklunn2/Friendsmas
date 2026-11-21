// A poll on a guest's phone (Block 4): tap a face, a team or an option.
// Votes can change until voting closes, and stay secret until the reveal.

import { useEffect, useRef, useState } from "react";
import { signed, type PlayerView } from "../../../shared/types";
import { useTicker } from "../net";
import { Avatar, formatClock, playerMap } from "../ui";

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

export function PhonePoll({ view, send, serverNow }: { view: PlayerView; send: Send; serverNow: () => number }) {
  const pl = view.poll;
  const a = pl ? view.activities.find((x) => x.id === pl.activityId) : undefined;
  const q = pl?.question ?? null;
  const open = pl?.phase === "open";
  useTicker(250, open && !!pl?.endsAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const players = playerMap(view.players);
  const teams = new Map(view.teams.map((t) => [t.id, t]));

  const lastQ = useRef<string | null>(null);
  useEffect(() => {
    if (q && q.id !== lastQ.current && pl?.phase === "open") navigator.vibrate?.(120);
    if (q?.id !== lastQ.current) {
      setError(null);
      setPending(null);
    }
    lastQ.current = q?.id ?? null;
  }, [q, pl?.phase]);

  if (!pl || !a) return null;
  const me = view.me!;
  const whowrote = pl.pollKind === "whowrote";

  if (pl.phase === "intro" || !q) {
    return (
      <article className="now-playing quiz-phone">
        <span className="now-playing__kicker">{whowrote ? "Who wrote this?" : "Poll time"}</span>
        <h2 className="now-playing__name">{a.name}</h2>
        <p className="now-playing__who">
          {whowrote
            ? "A secret fact goes up on the TV. Guess who wrote it. If it's yours, keep a straight face."
            : "The questions go up on the TV. Vote here. Nobody sees the votes until the reveal."}
        </p>
      </article>
    );
  }

  const vote = async (key: string) => {
    setError(null);
    setPending(key);
    try {
      await send("poll.vote", { questionId: q.id, key });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  const left = pl.endsAt ? pl.endsAt - serverNow() : null;
  const mine = view.myPollVote;
  const options = q.options.filter((o) => o.key !== me.id && !(q.optionsKind === "teams" && o.key === me.teamId));
  const reveal = pl.reveal;
  const myPoints = reveal?.points[me.id] ?? 0;
  const labelFor = (key: string) => {
    const t = teams.get(key);
    return t ? t.name ?? `Team ${t.order + 1}` : (q.options.find((o) => o.key === key)?.label ?? "");
  };

  return (
    <article className={`now-playing quiz-phone quiz-phone--${pl.phase}`}>
      <div className="now-playing__head">
        <span className="now-playing__kicker">
          {whowrote ? "Who wrote this?" : "Poll"} · {q.number} of {pl.total}
        </span>
        {open && left !== null && <span className="naming__clock">{formatClock(left)}</span>}
      </div>
      <p className="quiz-phone__prompt">{whowrote ? `“${q.prompt}”` : q.prompt}</p>

      {view.myFactOnTv ? (
        <p className="poll-phone__mine">🤫 This one's yours! Keep a straight face. You sit this one out.</p>
      ) : reveal ? (
        <div className="poll-phone__result">
          {whowrote ? (
            <p>
              {reveal.correctIds.includes(me.id) ? `You got it! ${signed(myPoints)} for your team.` : "Not this time."}{" "}
              {reveal.writerId && `It was ${players.get(reveal.writerId)?.name ?? "someone"}.`}
            </p>
          ) : (
            <p>
              {mine ? `You voted for ${labelFor(mine)}. ` : "You didn't vote. "}
              {myPoints ? `${signed(myPoints)} for your team!` : ""}
            </p>
          )}
        </div>
      ) : (
        <>
          <ul className={`poll-options poll-options--${q.optionsKind}`}>
            {options.map((o) => {
              const p = players.get(o.key);
              const t = teams.get(o.key);
              return (
                <li key={o.key}>
                  <button
                    className={`poll-option${mine === o.key ? " is-chosen" : ""}`}
                    disabled={!open || pending !== null}
                    onClick={() => vote(o.key)}
                    aria-pressed={mine === o.key}
                  >
                    {p && <Avatar player={p} className="poll-option__photo" />}
                    <span className="poll-option__label">{t ? labelFor(o.key) : o.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="phone__muted">
            {!open ? "Voting has closed. Watch the TV!" : mine ? "Vote saved. You can change it until time's up." : "Tap to vote. Nobody sees it until the reveal."}
          </p>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
