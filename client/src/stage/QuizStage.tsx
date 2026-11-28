// The quiz on the TV.

import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { OPTION_LETTERS, imageUrl, signed, teamDisplayName, type LiveQuestion, type PublicPlayer, type PublicTeam, type StageView } from "../../../shared/types";
import { audioOn, sfx } from "../audio";
import { useTicker } from "../net";
import { Avatar, formatClock, playerMap, teamStyle } from "../ui";
import { HouseCall } from "./HouseCall";

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
        <HouseCall view={view} activityId={a.id} />
        <p className="quiz-intro__how">
          📱 {a.kind === "team" ? "Answer on your phones: one answer per team, and the last one in counts." : "Answer on your own phone. Every right answer scores for your team."}
        </p>
        {a.speedBonus > 0 && <p className="quiz-intro__bonus">Fastest right answer: +{a.speedBonus} bonus</p>}
        {a.houseMatchesLowest && <p className="quiz-intro__bonus">🏠 The House scores the same as the lowest team this round.</p>}
      </section>
    );
  }

  const revealed = qz.phase === "revealed" && qz.reveal;
  const results = new Map((qz.reveal?.results ?? []).map((r) => [r.answererId, r]));
  const answered = new Set(qz.answeredIds);
  const choices = q.type === "choice" || q.type === "truefalse";
  const voting = !!q.choices;
  const correctIndex = revealed ? (qz.reveal!.correctIndex ?? -1) : -1;
  const teamMap = new Map(view.teams.map((t) => [t.id, t]));

  const answerers =
    qz.kind === "team"
      ? view.teams.map((t) => ({
          id: t.id,
          team: t,
          label: teamDisplayName(t),
          player: null,
          members: t.memberIds.map((id) => players.get(id)).filter((p) => !!p),
        }))
      : view.teams.flatMap((t) =>
          t.memberIds.map((id) => ({ id, team: t, label: players.get(id)?.name ?? "", player: players.get(id) ?? null, members: [] })),
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
          {q.type === "whowrote" && <p className="quiz-q__kicker">Who wrote this?</p>}
          <h1 className={`quiz-q__prompt${q.type === "whowrote" ? " quiz-q__prompt--fact" : ""}`}>{q.type === "whowrote" ? `“${q.prompt}”` : q.prompt}</h1>
          {voting ? (
            revealed ? (
              q.type === "whowrote" ? (
                <Writer player={qz.reveal!.writerId ? players.get(qz.reveal!.writerId) : undefined} />
              ) : (
                <VoteBars q={q} counts={qz.reveal!.counts ?? {}} winners={qz.reveal!.winners} players={players} teams={teamMap} />
              )
            ) : (
              <>
                <VoteChoices q={q} players={players} teams={teamMap} />
                <p className="quiz-q__type-hint">
                  {q.type === "whowrote" ? "Guess who wrote it on your phone. Their own team can't score." : "Vote on your phone. Teams that pick the most popular answer score."}
                </p>
              </>
            )
          ) : choices ? (
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
              {x.members.length > 0 && (
                <span className="quiz-chip__members">
                  {x.members.map((p) => (
                    <Avatar key={p!.id} player={p!} className="quiz-chip__avatar" />
                  ))}
                </span>
              )}
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

/** What teams can pick in a poll or "Who wrote this?", before the reveal. */
function VoteChoices({ q, players, teams }: { q: LiveQuestion; players: Map<string, PublicPlayer>; teams: Map<string, PublicTeam> }) {
  const list = q.choices ?? [];
  if (q.optionsKind === "players") {
    return (
      <ul className="quiz-faces">
        {list.map((c) => {
          const p = players.get(c.key);
          return (
            <li key={c.key} className="quiz-face">
              {p && <Avatar player={p} className="quiz-face__photo" />}
              <span className="quiz-face__name">{c.label}</span>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ol className={`quiz-options quiz-options--${Math.min(list.length, 6)}`}>
      {list.map((c, i) => {
        const t = teams.get(c.key);
        return (
          <li key={c.key} className="quiz-option" style={t ? teamStyle(t) : undefined}>
            {q.optionsKind === "custom" && <span className="quiz-option__letter">{OPTION_LETTERS[i]}</span>}
            <span className="quiz-option__text">{t ? teamDisplayName(t) : c.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** How the teams voted, most popular first. */
function VoteBars({
  q,
  counts,
  winners,
  players,
  teams,
}: {
  q: LiveQuestion;
  counts: Record<string, number>;
  winners: string[];
  players: Map<string, PublicPlayer>;
  teams: Map<string, PublicTeam>;
}) {
  const max = Math.max(1, ...Object.values(counts));
  const ranked = (q.choices ?? []).filter((c) => counts[c.key]).sort((x, y) => counts[y.key] - counts[x.key]);
  if (!ranked.length) return <p className="poll-stage__empty">Nobody voted!</p>;
  return (
    <ol className="poll-bars quiz-q__bars">
      {ranked.map((c, i) => {
        const p = players.get(c.key);
        const t = teams.get(c.key);
        const win = winners.includes(c.key);
        return (
          <li
            key={c.key}
            className={`poll-bar${win ? " is-winner" : ""}`}
            style={{ "--w": `${(counts[c.key] / max) * 100}%`, animationDelay: `${(ranked.length - 1 - i) * 350}ms`, ...(t ? teamStyle(t) : {}) } as CSSProperties}
          >
            <span className="poll-bar__who">
              {p && <Avatar player={p} className="poll-bar__photo" />}
              <span className="poll-bar__name">{t ? teamDisplayName(t) : c.label}</span>
              {win && (
                <span className="poll-bar__crown" aria-label="Most popular">
                  👑
                </span>
              )}
            </span>
            <span className="poll-bar__track">
              <span className="poll-bar__fill" />
            </span>
            <span className="poll-bar__count">{counts[c.key]}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Writer({ player }: { player: PublicPlayer | undefined }) {
  return (
    <div className="unmask__writer quiz-q__writer">
      {player ? <Avatar player={player} className="unmask__photo" /> : <span className="unmask__photo">?</span>}
      <p className="unmask__name">It was {player?.name ?? "a mystery"}!</p>
    </div>
  );
}
